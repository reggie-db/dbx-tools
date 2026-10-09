/**
 * Skill folders are the mapping a consuming app configures, so the cases here
 * pin the two halves it depends on: what the built-in names resolve to, and how
 * a consumer's map merges over them.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { CacheManager } from "@databricks/appkit";
import type { FilesCacheExports } from "@dbx-tools/appkit/files-cache";
import { log } from "@dbx-tools/shared-core";
import { MemoryFileSystem, type CacheValue, type FileSystemCache } from "@dbx-tools/shared-fs";
import { RequestContext } from "@mastra/core/request-context";
import { resolveToolConfig, WORKSPACE_TOOLS, type WorkspaceSandbox } from "@mastra/core/workspace";

import { buildAgents } from "../src/agents.ts";
import { MASTRA_SCOPES_KEY, MASTRA_USER_EMAIL_KEY, MASTRA_USER_KEY } from "../src/config.ts";
import { filesystems } from "../src/filesystems.ts";
import { MontySandbox } from "../src/monty-sandbox.ts";
import { DatabricksSandbox } from "../src/sandbox.ts";
import { ORGANIZATION_ASSISTANT_PATH } from "../src/skill-paths.ts";
import {
  createWorkspace,
  DEFAULT_SKILL_FOLDERS,
  resolveSkillFolders,
  type SkillFolderOptions,
} from "../src/workspaces.ts";

before(async () => {
  await CacheManager.getInstance();
});

/** Invoke a skill folder's `path`, whether it is a literal or a resolver. */
async function resolvePath(
  folder: SkillFolderOptions,
  requestContext?: RequestContext,
): Promise<string | undefined> {
  return typeof folder.path === "function" ? folder.path({ requestContext }) : folder.path;
}

/** Resolve Mastra's request-scoped skill view for a workspace test. */
async function resolveWorkspaceSkills(
  workspace: ReturnType<typeof createWorkspace>,
  requestContext: RequestContext,
) {
  const skills = workspace.skills;
  assert.ok(skills);
  return (await skills.getScoped?.({ requestContext })) ?? skills;
}

describe("DEFAULT_SKILL_FOLDERS", () => {
  it("maps organization-skills to the shared tree with approved writes", async () => {
    const folder = DEFAULT_SKILL_FOLDERS["organization-skills"];
    assert.equal(await resolvePath(folder), ORGANIZATION_ASSISTANT_PATH);
    assert.deepEqual(folder.skills, ["skills"]);
    assert.equal(folder.readable, true);
    assert.equal(folder.writable, true);
    assert.equal(folder.createRoot, false);
  });

  it("maps personal-skills to the requesting user's tree, writable", async () => {
    const folder = DEFAULT_SKILL_FOLDERS["personal-skills"];
    assert.equal(folder.readable, true);
    assert.equal(folder.writable, true);
    assert.equal(folder.createRoot, false);

    const requestContext = new RequestContext();
    requestContext.set(MASTRA_USER_EMAIL_KEY, " user@example.com ");
    assert.equal(
      await resolvePath(folder, requestContext),
      "/Workspace/Users/user@example.com",
    );
    assert.deepEqual(folder.skills, [".assistant/skills"]);
  });

  it("skips personal-skills when the request carries no user email", async () => {
    const folder = DEFAULT_SKILL_FOLDERS["personal-skills"];
    assert.equal(await resolvePath(folder), undefined);
    assert.equal(await resolvePath(folder, new RequestContext()), undefined);
  });
});

describe("resolveSkillFolders", () => {
  it("returns the built-in defaults when nothing is configured", () => {
    assert.deepEqual(Object.keys(resolveSkillFolders()).sort(), [
      "organization-skills",
      "personal-skills",
    ]);
  });

  it("drops the defaults when assistantSkills is false", () => {
    assert.deepEqual(resolveSkillFolders({ assistantSkills: false }), {});
  });

  it("keeps explicit folders when the defaults are off", () => {
    const custom: SkillFolderOptions = { path: "/Workspace/Shared/custom", writable: true };
    assert.deepEqual(resolveSkillFolders({ assistantSkills: false, skillFolders: { custom } }), {
      custom,
    });
  });

  it("overrides one default by name and leaves the other alone", () => {
    const resolved = resolveSkillFolders({
      skillFolders: {
        "organization-skills": {
          path: "/Workspace/Shared/organization-skills",
          writable: true,
        },
      },
    });
    assert.equal(resolved["organization-skills"]?.path, "/Workspace/Shared/organization-skills");
    assert.equal(resolved["organization-skills"]?.writable, true);
    assert.ok(resolved["personal-skills"]);
  });

  it("disables a default with false", () => {
    assert.deepEqual(
      Object.keys(resolveSkillFolders({ skillFolders: { "personal-skills": false } })),
      ["organization-skills"],
    );
  });

  it("adds a consumer-defined folder alongside the defaults", () => {
    const resolved = resolveSkillFolders({
      skillFolders: { runbooks: { path: "/Workspace/Shared/runbooks" } },
    });
    assert.deepEqual(Object.keys(resolved).sort(), [
      "organization-skills",
      "personal-skills",
      "runbooks",
    ]);
  });
});

describe("createWorkspace sandbox", () => {
  it("uses Monty by default", async () => {
    const workspace = createWorkspace({ assistantSkills: false, id: "analyst" });
    const requestContext = new RequestContext();

    const first = await workspace.resolveSandbox({ requestContext });
    const second = await workspace.resolveSandbox({ requestContext });

    assert.ok(first instanceof MontySandbox);
    assert.equal(first, second);
  });

  it("can disable or select another sandbox explicitly", async () => {
    const disabled = createWorkspace({ assistantSkills: false, sandbox: false });
    assert.equal(
      await disabled.resolveSandbox({ requestContext: new RequestContext() }),
      undefined,
    );

    const custom: WorkspaceSandbox = {
      id: "custom",
      name: "Custom",
      provider: "custom",
      status: "running",
      async snapshot() {},
    };
    const replaced = createWorkspace({ assistantSkills: false, sandbox: custom });
    assert.equal(await replaced.resolveSandbox({ requestContext: new RequestContext() }), custom);

    const databricks = createWorkspace({
      assistantSkills: false,
      id: "analyst",
      sandbox: "databricks",
    });
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_USER_KEY, {
      id: "user-1",
      executionContext: { client: {} },
    });
    const resolved = await databricks.resolveSandbox({ requestContext });
    assert.ok(resolved instanceof DatabricksSandbox);
    assert.equal(resolved.provider, "databricks");
    assert.match(resolved.id, /^mastra-[a-f0-9]{32}$/);
  });
});

describe("createWorkspace skill source identity", () => {
  it("mounts local scratch at /tmp without Databricks workspace access", async () => {
    const workspace = createWorkspace({ assistantSkills: false, sandbox: false });
    const filesystem = await workspace.resolveFilesystem({
      requestContext: new RequestContext(),
    });
    assert.ok(filesystem);

    await filesystem.writeFile("/tmp/note.txt", "scratch");

    assert.equal(await filesystem.readFile("/tmp/note.txt", { encoding: "utf8" }), "scratch");
    assert.deepEqual(
      (await filesystem.readdir("/")).map(({ name }) => name),
      ["tmp"],
    );
    await filesystem.destroy?.();
  });

  it("skips inaccessible organization and personal roots on first load", async () => {
    const appkitClient = {
      config: {
        async getHost() {
          return new URL("https://workspace.example.com");
        },
      },
      toLegacyWorkspaceClient() {
        return {
          workspace: {
            async getStatus() {
              throw Object.assign(new Error("forbidden"), { statusCode: 403 });
            },
          },
        };
      },
    };
    const workspace = createWorkspace({ sandbox: false });
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_SCOPES_KEY, ["workspace.workspace"]);
    requestContext.set(MASTRA_USER_EMAIL_KEY, "user@example.com");
    requestContext.set(MASTRA_USER_KEY, {
      id: "user-1",
      executionContext: { client: appkitClient },
    });

    const filesystem = await workspace.resolveFilesystem({ requestContext });
    assert.ok(filesystem);

    assert.deepEqual(
      (await filesystem.readdir("/")).map(({ name }) => name),
      ["tmp"],
    );
    await filesystem.destroy?.();
  });

  it("leaves request-scoped filesystem reuse to Mastra", async () => {
    const mount = filesystems(new MemoryFileSystem({ root: "/skills" }));
    const workspace = createWorkspace({
      assistantSkills: false,
      sandbox: false,
      mounts: [
        () => ({
          mounts: { "/skills": mount },
          skillPaths: ["/skills"],
        }),
      ],
    });
    const firstContext = new RequestContext();
    const secondContext = new RequestContext();

    const first = await workspace.resolveFilesystem({ requestContext: firstContext });
    const repeated = await workspace.resolveFilesystem({ requestContext: firstContext });
    const second = await workspace.resolveFilesystem({ requestContext: secondContext });

    assert.equal(first, repeated);
    assert.notEqual(first, second);
  });

  it("keeps first-root precedence for duplicate skill names", async () => {
    const team = new MemoryFileSystem({ root: "/team" });
    const app = new MemoryFileSystem({ root: "/app" });
    await team.writeFile(
      "databricks-jobs/SKILL.md",
      "---\nname: databricks-jobs\ndescription: Shared jobs guidance\n---\nTeam instructions",
    );
    await app.writeFile(
      "databricks-jobs/SKILL.md",
      "---\nname: databricks-jobs\ndescription: User jobs guidance\n---\nUser instructions",
    );
    await app.writeFile(
      "personal-runbook/SKILL.md",
      "---\nname: personal-runbook\ndescription: User-only runbook\n---\nPersonal instructions",
    );
    const workspace = createWorkspace({
      assistantSkills: false,
      sandbox: false,
      skillFolders: {
        "organization-skills": {
          filesystem: filesystems(team),
          mount: "/organization-skills",
        },
        "personal-skills": {
          filesystem: filesystems(app),
          mount: "/personal-skills",
          writable: true,
        },
      },
    });
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_SCOPES_KEY, ["workspace"]);
    const catalogue = await resolveWorkspaceSkills(workspace, requestContext);
    const skills = await catalogue.list();

    assert.deepEqual(skills.map(({ name }) => name).sort(), [
      "databricks-jobs",
      "personal-runbook",
    ]);
    assert.equal(
      (await catalogue.get("databricks-jobs"))?.instructions,
      "Team instructions",
    );
    await assert.doesNotReject(() => catalogue.search("jobs"));
  });

  it("mounts startup-provisioned local skill roots for search", async () => {
    const root = await mkdtemp(join(tmpdir(), "appkit-mastra-skills-"));
    const skill = join(root, "databricks-apps");
    await mkdir(skill);
    await writeFile(
      join(skill, "SKILL.md"),
      [
        "---",
        "name: databricks-apps",
        "description: Build and operate Databricks Apps.",
        "---",
        "Use this skill for Databricks Apps deployment and runtime guidance.",
      ].join("\n"),
    );
    try {
      const workspace = createWorkspace({
        assistantSkills: false,
        sandbox: false,
        extraSkillPaths: [root],
      });
      const catalogue = await resolveWorkspaceSkills(workspace, new RequestContext());

      assert.deepEqual(
        (await catalogue.list()).map(({ name }) => name),
        ["databricks-apps"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes skills after native workspace file mutations", async () => {
    const app = new MemoryFileSystem({ root: "/app" });
    const global = new MemoryFileSystem({ root: "/global" });
    const workspace = createWorkspace({
      assistantSkills: false,
      sandbox: false,
      mounts: [
        () => ({
          mounts: {
            "/personal-skills": filesystems(app),
            "/shared-skills": filesystems(global),
          },
          skillPaths: ["/personal-skills", "/shared-skills"],
        }),
      ],
    });
    const requestContext = new RequestContext();
    const skills = await resolveWorkspaceSkills(workspace, requestContext);
    assert.deepEqual(await skills.list(), []);
    const filesystem = await workspace.resolveFilesystem({ requestContext });
    assert.ok(filesystem);
    await filesystem.writeFile(
      "/personal-skills/computer-jokes/SKILL.md",
      [
        "---",
        "name: computer-jokes",
        "description: Remember that the user likes jokes about computers.",
        "---",
        "When appropriate, prefer jokes about computers.",
      ].join("\n"),
    );

    assert.match(
      await app.readFile("computer-jokes/SKILL.md", { encoding: "utf8" }),
      /name: computer-jokes/,
    );
    const refreshed = await resolveWorkspaceSkills(workspace, new RequestContext());
    assert.equal((await refreshed.list())[0]?.name, "computer-jokes");
    assert.equal(
      workspace.getToolsConfig()?.[WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]?.requireApproval,
      undefined,
    );
    assert.equal(
      typeof workspace.getToolsConfig()?.[WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]?.requireApproval,
      "function",
    );
    assert.equal(
      (await resolveToolConfig(workspace.getToolsConfig(), WORKSPACE_TOOLS.FILESYSTEM.READ_FILE))
        .requireApproval,
      false,
    );
  });

  it("wraps Databricks skill sources with the AppKit-global files cache", async () => {
    const skill = [
      "---",
      "name: cached-skill",
      "description: Cached skill",
      "---",
      "Use the cached skill.",
    ].join("\n");
    let listCalls = 0;
    let exportCalls = 0;
    const imports: string[] = [];
    const legacyClient = {
      workspace: {
        async mkdirs() {},
        async import({ path }: { path: string }) {
          imports.push(path);
        },
        async getStatus({ path }: { path: string }) {
          if (path.endsWith("SKILL.md") && !path.includes("/cached-skill/")) {
            throw Object.assign(new Error("not found"), { statusCode: 404 });
          }
          return {
            path,
            object_type: path.endsWith("SKILL.md") ? "NOTEBOOK" : "DIRECTORY",
            modified_at: 1,
          };
        },
        list({ path }: { path: string }) {
          listCalls += 1;
          return (async function* () {
            if (path === "/Workspace/.assistant") {
              yield {
                path: `${path}/skills`,
                object_type: "DIRECTORY",
                modified_at: 1,
              };
            } else if (path === "/Workspace/.assistant/skills") {
              yield {
                path: `${path}/cached-skill`,
                object_type: "DIRECTORY",
                modified_at: 1,
              };
            } else if (path === "/Workspace/.assistant/skills/cached-skill") {
              yield {
                path: `${path}/SKILL.md`,
                object_type: "FILE",
                modified_at: 1,
              };
            }
          })();
        },
        async export() {
          exportCalls += 1;
          return { content: Buffer.from(skill).toString("base64") };
        },
      },
    };
    const appkitClient = {
      config: {
        async getHost() {
          return new URL("https://workspace.example.com");
        },
      },
      toLegacyWorkspaceClient() {
        return legacyClient;
      },
    };
    const values = new Map<string, CacheValue>();
    const filesystemCache: FileSystemCache = {
      async read(key, load) {
        if (values.has(key)) return values.get(key) as never;
        const value = await load();
        values.set(key, value);
        return value;
      },
      invalidate(key) {
        values.delete(key);
      },
      keys() {
        return values.keys();
      },
    };
    const scopes: unknown[] = [];
    const sources = new Map<string, object>();
    const filesCache: FilesCacheExports = {
      async forScope(scope) {
        scopes.push(scope);
        return filesystemCache;
      },
      async forFileSystem(scope, identity, load) {
        const key = JSON.stringify([scope, identity]);
        const existing = sources.get(key);
        if (existing) return existing as Awaited<ReturnType<typeof load>>;
        const source = await load();
        sources.set(key, source);
        return source;
      },
      async flush() {},
    };
    const workspace = createWorkspace({
      sandbox: false,
      pluginContext: {
        getPlugins: () =>
          new Map([
            [
              "files-cache",
              {
                exports: () => filesCache,
              },
            ],
          ]),
      },
    });
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_SCOPES_KEY, ["workspace.workspace"]);
    requestContext.set(MASTRA_USER_EMAIL_KEY, "user@example.com");
    requestContext.set(MASTRA_USER_KEY, {
      id: "user-1",
      executionContext: { client: appkitClient },
    });
    const filesystem = await workspace.resolveFilesystem({ requestContext });
    assert.ok(filesystem);

    const organizationMount = (await filesystem.readdir("/Workspace")).find(
      ({ name }) => name === ".assistant",
    );
    assert.equal(organizationMount?.mount?.displayName, "Organization Skills");
    assert.match(organizationMount?.mount?.description ?? "", /shared with everyone/);
    const personalMount = (await filesystem.readdir("/Workspace/Users")).find(
      ({ name }) => name === "user@example.com",
    );
    assert.equal(personalMount?.mount?.displayName, "Home");
    assert.match(personalMount?.mount?.description ?? "", /personal files and skills/);
    await filesystem.writeFile("/Workspace/.assistant/note.txt", "approved elsewhere");
    assert.deepEqual(imports, ["/Workspace/.assistant/note.txt"]);
    await filesystem.readdir("/Workspace/.assistant");
    await filesystem.readdir("/Workspace/.assistant");
    assert.equal(listCalls, 1);
    const nextRequestContext = new RequestContext();
    nextRequestContext.set(MASTRA_SCOPES_KEY, ["workspace.workspace"]);
    nextRequestContext.set(MASTRA_USER_EMAIL_KEY, "user@example.com");
    nextRequestContext.set(MASTRA_USER_KEY, {
      id: "user-1",
      executionContext: { client: appkitClient },
    });
    assert.equal(
      await workspace.resolveFilesystem({ requestContext: nextRequestContext }),
      filesystem,
    );
    const firstSkills = await resolveWorkspaceSkills(workspace, requestContext);
    assert.deepEqual(
      (await firstSkills.list()).map(({ name }) => name),
      ["cached-skill"],
    );
    const firstExportCalls = exportCalls;
    const nextSkills = await resolveWorkspaceSkills(workspace, nextRequestContext);
    assert.deepEqual(
      (await nextSkills.list()).map(({ name }) => name),
      ["cached-skill"],
    );
    assert.equal(exportCalls, firstExportCalls);
    assert.deepEqual(scopes, [
      { host: "https://workspace.example.com/", userKey: "user-1" },
      { host: "https://workspace.example.com/", userKey: "user-1" },
    ]);
  });

  it("lets native Mastra workspace tool configuration override approval defaults", async () => {
    const workspace = createWorkspace({
      assistantSkills: false,
      sandbox: false,
      tools: {
        requireApproval: false,
        [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: { requireApproval: true },
      },
    });

    assert.equal(workspace.getToolsConfig()?.requireApproval, false);
    assert.equal(
      workspace.getToolsConfig()?.[WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]?.requireApproval,
      undefined,
    );
    assert.equal(
      workspace.getToolsConfig()?.[WORKSPACE_TOOLS.FILESYSTEM.DELETE]?.requireApproval,
      true,
    );
    assert.equal(
      (await resolveToolConfig(workspace.getToolsConfig(), WORKSPACE_TOOLS.FILESYSTEM.READ_FILE))
        .requireApproval,
      false,
    );
    assert.equal(
      (await resolveToolConfig(workspace.getToolsConfig(), WORKSPACE_TOOLS.FILESYSTEM.DELETE))
        .requireApproval,
      true,
    );
  });

  it("requires approval for every filesystem mutation outside the user home", async () => {
    const workspace = createWorkspace({ assistantSkills: false, sandbox: false });
    const mutationTools = [
      WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
      WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
      WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
      WORKSPACE_TOOLS.FILESYSTEM.DELETE,
      WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
    ] as const;
    const requestContext = {
      [MASTRA_USER_EMAIL_KEY]: "user@example.com",
    };

    for (const tool of mutationTools) {
      const config = await resolveToolConfig(workspace.getToolsConfig(), tool);
      assert.equal(typeof config.requireApproval, "function");
      if (typeof config.requireApproval !== "function") continue;
      assert.equal(
        await config.requireApproval({
          args: { path: "/Workspace/Users/user@example.com/.assistant/skills/example/SKILL.md" },
          requestContext,
          workspace,
        }),
        false,
      );
      assert.equal(
        await config.requireApproval({
          args: { path: "/Workspace/.assistant/skills/shared/SKILL.md" },
          requestContext,
          workspace,
        }),
        true,
      );
      assert.equal(
        await config.requireApproval({
          args: { path: "/tmp/note.txt" },
          requestContext,
          workspace,
        }),
        true,
      );
      assert.equal(
        await config.requireApproval({
          args: { path: "/Workspace/Users/user@example.com/note.txt" },
          requestContext: {},
          workspace,
        }),
        true,
      );
    }
  });
});

describe("agent workspace selection", () => {
  it("preserves an explicit workspace resolver opt-out", async () => {
    const built = await buildAgents({
      config: {
        agents: {
          analyst: {
            instructions: "Answer directly.",
            workspace: () => undefined,
          },
        },
      },
      context: undefined,
      log: log.logger("test/agents"),
    });

    assert.equal(await built.agents.analyst?.getWorkspace(), undefined);
  });

  it("forwards Mastra's native conditional approval gate", async () => {
    const requireToolApproval = async () => false;
    const built = await buildAgents({
      config: {
        agents: {
          analyst: {
            instructions: "Answer directly.",
            requireToolApproval,
          },
        },
      },
      context: undefined,
      log: log.logger("test/agents"),
    });

    const options = await built.agents.analyst?.getDefaultOptions();
    assert.equal(options?.requireToolApproval, requireToolApproval);
  });

  it("uses Mastra's native on-demand skill discovery by default", async () => {
    const built = await buildAgents({
      config: {},
      context: undefined,
      log: log.logger("test/agents"),
    });

    const processors = await built.agents[built.defaultAgentId]?.listConfiguredInputProcessors();
    assert.ok(processors?.some((processor) => "id" in processor && processor.id === "skill-search"));
  });

  it("can disable Mastra's skill search processor explicitly", async () => {
    const built = await buildAgents({
      config: { workspaceSkills: false },
      context: undefined,
      log: log.logger("test/agents"),
    });

    const processors = await built.agents[built.defaultAgentId]?.listConfiguredInputProcessors();
    assert.ok(
      processors?.every((processor) => !("id" in processor) || processor.id !== "skill-search"),
    );
  });
});
