/** Databricks workspace path, cache, skill, and approval behavior. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { CacheManager } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";
import type { FilesCacheExports } from "@dbx-tools/appkit/files-cache";
import { log } from "@dbx-tools/shared-core";
import { MemoryFileSystem, type CacheValue, type FileSystemCache } from "@dbx-tools/shared-fs";
import { isEventedAgent } from "@mastra/core/agent/durable";
import { RequestContext } from "@mastra/core/request-context";
import { resolveToolConfig, WORKSPACE_TOOLS, type WorkspaceSandbox } from "@mastra/core/workspace";

import { buildAgents } from "../src/agents.ts";
import { MASTRA_SCOPES_KEY, MASTRA_USER_EMAIL_KEY, MASTRA_USER_KEY } from "../src/config.ts";
import { filesystems } from "../src/filesystems.ts";
import { MontySandbox } from "../src/monty-sandbox.ts";
import { DatabricksSandbox } from "../src/sandbox.ts";
import { ORGANIZATION_ASSISTANT_PATH } from "../src/skill-paths.ts";
import {
  databricksWorkspace,
  databricksWorkspaceConfig,
  DEFAULT_DATABRICKS_WORKSPACE_PATHS,
  resolveDatabricksWorkspacePaths,
  type DatabricksWorkspacePathOptions,
} from "../src/workspaces.ts";

before(async () => {
  await appkit.ensureInitialized();
  await CacheManager.getInstance();
});

/** Resolve Mastra's request-scoped skill view for a workspace test. */
async function resolveWorkspaceSkills(
  workspace: ReturnType<typeof databricksWorkspace>,
  requestContext: RequestContext,
) {
  const skills = workspace.skills;
  assert.ok(skills);
  return (await skills.getScoped?.({ requestContext })) ?? skills;
}

describe("DEFAULT_DATABRICKS_WORKSPACE_PATHS", () => {
  it("uses paths as their mount identity", () => {
    const organization = DEFAULT_DATABRICKS_WORKSPACE_PATHS[0];
    assert.equal(organization?.path, ORGANIZATION_ASSISTANT_PATH);
    assert.deepEqual(organization?.skills, ["skills"]);
    assert.equal(organization?.writable, true);
    assert.equal(organization?.mount, undefined);
  });

  it("uses the home shortcut for the current user's path", () => {
    const home = DEFAULT_DATABRICKS_WORKSPACE_PATHS[1];
    assert.equal(home?.path, "~");
    assert.deepEqual(home?.skills, [".assistant/skills"]);
    assert.equal(home?.writable, true);
  });
});

describe("resolveDatabricksWorkspacePaths", () => {
  it("returns the built-in defaults when nothing is configured", () => {
    assert.deepEqual(resolveDatabricksWorkspacePaths(), DEFAULT_DATABRICKS_WORKSPACE_PATHS);
  });

  it("drops the defaults when assistantPaths is false", () => {
    assert.deepEqual(resolveDatabricksWorkspacePaths({ assistantPaths: false }), []);
  });

  it("appends string and configured paths", () => {
    const runbooks = {
      path: "/Workspace/Shared/runbooks",
      skills: ["."],
    } satisfies DatabricksWorkspacePathOptions;
    assert.deepEqual(
      resolveDatabricksWorkspacePaths({
        assistantPaths: false,
        paths: ["/Volumes/main/default/data", runbooks],
      }),
      ["/Volumes/main/default/data", runbooks],
    );
  });

  it("returns a native Mastra workspace config", () => {
    const config = databricksWorkspaceConfig({ assistantPaths: false, sandbox: false });
    assert.equal(typeof config.filesystem, "function");
    assert.equal(config.sandbox, undefined);
  });
});

describe("databricksWorkspace sandbox", () => {
  it("uses Monty by default", async () => {
    const workspace = databricksWorkspace({ assistantPaths: false, id: "analyst" });
    const requestContext = new RequestContext();

    const first = await workspace.resolveSandbox({ requestContext });
    const second = await workspace.resolveSandbox({ requestContext });

    assert.ok(first instanceof MontySandbox);
    assert.equal(first, second);
  });

  it("can disable or select another sandbox explicitly", async () => {
    const disabled = databricksWorkspace({ assistantPaths: false, sandbox: false });
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
    const replaced = databricksWorkspace({ assistantPaths: false, sandbox: custom });
    assert.equal(await replaced.resolveSandbox({ requestContext: new RequestContext() }), custom);

    const databricks = databricksWorkspace({
      assistantPaths: false,
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

describe("databricksWorkspace skill source identity", () => {
  it("does not mount /tmp unless requested", async () => {
    const workspace = databricksWorkspace({ assistantPaths: false, sandbox: false });
    const filesystem = await workspace.resolveFilesystem({
      requestContext: new RequestContext(),
    });
    assert.ok(filesystem);
    assert.deepEqual(await filesystem.readdir("/"), []);
    await filesystem.destroy?.();
  });

  it("maps an explicit /tmp path to stable user-scoped ephemeral storage", async () => {
    const workspace = databricksWorkspace({
      assistantPaths: false,
      paths: ["/tmp"],
      sandbox: false,
    });
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_USER_KEY, { id: "user-1", executionContext: { client: {} } });
    const first = await workspace.resolveFilesystem({ requestContext });
    assert.ok(first);
    await first.writeFile("/tmp/note.txt", "scratch");
    assert.equal(await first.readFile("/tmp/note.txt", { encoding: "utf8" }), "scratch");
    assert.deepEqual(
      (await first.readdir("/")).map(({ name }) => name),
      ["tmp"],
    );

    const scopedWorkspace = databricksWorkspace({
      assistantPaths: false,
      paths: ["/tmp/project"],
      sandbox: false,
    });
    const scoped = await scopedWorkspace.resolveFilesystem({ requestContext });
    assert.ok(scoped);
    await scoped.writeFile("/tmp/project/result.txt", "scoped");
    assert.equal(await scoped.readFile("/tmp/project/result.txt", { encoding: "utf8" }), "scoped");
    await assert.rejects(() => scoped.readFile("/tmp/note.txt", { encoding: "utf8" }));
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
    const workspace = databricksWorkspace({ sandbox: false });
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
      [],
    );
    await filesystem.destroy?.();
  });

  it("leaves request-scoped filesystem reuse to Mastra", async () => {
    const mount = filesystems(new MemoryFileSystem({ root: "/skills" }));
    const workspace = databricksWorkspace({
      assistantPaths: false,
      sandbox: false,
      mounts: { "/skills": mount },
    });
    const firstContext = new RequestContext();
    const secondContext = new RequestContext();

    const first = await workspace.resolveFilesystem({ requestContext: firstContext });
    const repeated = await workspace.resolveFilesystem({ requestContext: firstContext });
    const second = await workspace.resolveFilesystem({ requestContext: secondContext });

    assert.equal(first, repeated);
    assert.notEqual(first, second);
  });

  it("resolves home shortcuts and dynamic folder fields per request", async () => {
    const statusPaths: string[] = [];
    const appkitClient = {
      config: {
        async getHost() {
          return new URL("https://workspace.example.com");
        },
      },
      toLegacyWorkspaceClient() {
        return {
          workspace: {
            async getStatus({ path }: { path: string }) {
              statusPaths.push(path);
              return { path, object_type: "DIRECTORY" };
            },
            list() {
              return (async function* () {})();
            },
          },
        };
      },
    };
    const workspace = databricksWorkspace({
      assistantPaths: false,
      sandbox: false,
      cache: () => {
        throw new Error("cache policy must not resolve without the files-cache plugin");
      },
      paths: [
        ({ requestContext }) => ({
          path: "~",
          displayName: `Home for ${requestContext?.get(MASTRA_USER_EMAIL_KEY)}`,
          readable: false,
          writable: true,
          createRoot: false,
        }),
      ],
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
    const home = (await filesystem.readdir("/Workspace/Users")).find(
      ({ name }) => name === "user@example.com",
    );
    assert.equal(home?.mount?.displayName, "Home for user@example.com");
    assert.ok(statusPaths.includes("/Workspace/Users/user@example.com"));
  });

  it("preserves Mastra's native duplicate-skill error", async () => {
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
    const workspace = databricksWorkspace({
      assistantPaths: false,
      sandbox: false,
      mounts: {
        "/organization-skills": filesystems(team),
        "/personal-skills": filesystems(app),
      },
      skills: ["/organization-skills", "/personal-skills"],
    });
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_SCOPES_KEY, ["workspace"]);
    const catalogue = await resolveWorkspaceSkills(workspace, requestContext);
    const skills = await catalogue.list();

    assert.deepEqual(skills.map(({ name }) => name).sort(), [
      "databricks-jobs",
      "databricks-jobs",
      "personal-runbook",
    ]);
    await assert.rejects(() => catalogue.get("databricks-jobs"), /multiple local skills found/);
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
      const workspace = databricksWorkspace({
        assistantPaths: false,
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
    const workspace = databricksWorkspace({
      assistantPaths: false,
      sandbox: false,
      mounts: {
        "/personal-skills": filesystems(app),
        "/shared-skills": filesystems(global),
      },
      skills: ["/personal-skills", "/shared-skills"],
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
      workspace.getToolsConfig()?.[WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]?.requireApproval,
      undefined,
    );
    assert.equal(
      (await resolveToolConfig(workspace.getToolsConfig(), WORKSPACE_TOOLS.FILESYSTEM.READ_FILE))
        .requireApproval,
      false,
    );
    assert.equal(
      (await resolveToolConfig(workspace.getToolsConfig(), WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE))
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
    const workspace = databricksWorkspace({
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
    assert.equal(organizationMount?.mount?.displayName, undefined);
    assert.equal(organizationMount?.mount?.description, undefined);
    const personalMount = (await filesystem.readdir("/Workspace/Users")).find(
      ({ name }) => name === "user@example.com",
    );
    assert.equal(personalMount?.mount?.displayName, undefined);
    assert.equal(personalMount?.mount?.description, undefined);
    await filesystem.writeFile("/Workspace/.assistant/note.txt", "approved elsewhere");
    assert.deepEqual(imports, ["/Workspace/.assistant/note.txt"]);
    await filesystem.readdir("/Workspace/.assistant");
    await filesystem.readdir("/Workspace/.assistant");
    assert.equal(listCalls, 1);
    const regularReadCalls = exportCalls;
    await filesystem.readFile("/Workspace/.assistant/note.txt", { encoding: "utf8" });
    await filesystem.readFile("/Workspace/.assistant/note.txt", { encoding: "utf8" });
    assert.equal(exportCalls, regularReadCalls + 2);
    const skillReadCalls = exportCalls;
    await filesystem.readFile("/Workspace/.assistant/skills/cached-skill/SKILL.md", {
      encoding: "utf8",
    });
    await filesystem.readFile("/Workspace/.assistant/skills/cached-skill/SKILL.md", {
      encoding: "utf8",
    });
    assert.equal(exportCalls, skillReadCalls + 1);
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

    values.clear();
    listCalls = 0;
    exportCalls = 0;
    const filteredWorkspace = databricksWorkspace({
      assistantPaths: false,
      sandbox: false,
      cache: {
        operations: "readFile",
        paths: "/Workspace/.assistant/note.txt",
      },
      paths: [
        {
          path: "/Workspace/.assistant",
          readable: false,
          writable: true,
          createRoot: false,
        },
      ],
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
    const filteredContext = new RequestContext();
    filteredContext.set(MASTRA_SCOPES_KEY, ["workspace.workspace"]);
    filteredContext.set(MASTRA_USER_EMAIL_KEY, "user@example.com");
    filteredContext.set(MASTRA_USER_KEY, {
      id: "user-2",
      executionContext: { client: appkitClient },
    });
    const filteredFilesystem = await filteredWorkspace.resolveFilesystem({
      requestContext: filteredContext,
    });
    assert.ok(filteredFilesystem);
    const listBaseline = listCalls;
    await filteredFilesystem.readdir("/Workspace/.assistant");
    await filteredFilesystem.readdir("/Workspace/.assistant");
    assert.equal(listCalls, listBaseline + 2);
    const filteredReadBaseline = exportCalls;
    await filteredFilesystem.readFile("/Workspace/.assistant/note.txt", { encoding: "utf8" });
    await filteredFilesystem.readFile("/Workspace/.assistant/note.txt", { encoding: "utf8" });
    assert.equal(exportCalls, filteredReadBaseline + 1);
    const uncachedReadBaseline = exportCalls;
    await filteredFilesystem.readFile("/Workspace/.assistant/other.txt", { encoding: "utf8" });
    await filteredFilesystem.readFile("/Workspace/.assistant/other.txt", { encoding: "utf8" });
    assert.equal(exportCalls, uncachedReadBaseline + 2);
  });

  it("lets native Mastra workspace tool configuration override approval defaults", async () => {
    const workspace = databricksWorkspace({
      assistantPaths: false,
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

  it("enables workspace tools without approval by default", async () => {
    const workspace = databricksWorkspace({ assistantPaths: false });
    const defaultTools = [
      WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
      WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
      WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
      WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
      WORKSPACE_TOOLS.FILESYSTEM.DELETE,
      WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
      WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
    ] as const;

    assert.equal(workspace.getToolsConfig()?.enabled, true);
    assert.equal(workspace.getToolsConfig()?.requireApproval, false);
    for (const tool of defaultTools) {
      const config = await resolveToolConfig(workspace.getToolsConfig(), tool);
      assert.equal(config.enabled, true);
      assert.equal(config.requireApproval, false);
    }
  });
});

describe("agent workspace selection", () => {
  it("uses evented durable agents by default with an explicit opt-out", async () => {
    const durable = await buildAgents({
      config: { agents: { analyst: { instructions: "Answer directly." } } },
      context: undefined,
      log: log.logger("test/agents"),
    });
    const attached = await buildAgents({
      config: {
        backgroundTurns: false,
        agents: { analyst: { instructions: "Answer directly." } },
      },
      context: undefined,
      log: log.logger("test/agents"),
    });

    assert.equal(isEventedAgent(durable.agents.analyst), true);
    assert.equal(isEventedAgent(attached.agents.analyst), false);
  });

  it("tells agents to batch independent tool calls", async () => {
    const built = await buildAgents({
      config: {
        agents: {
          analyst: {
            instructions: "Answer directly.",
          },
        },
        styleInstructions: false,
      },
      context: undefined,
      log: log.logger("test/agents"),
    });

    const instructions = await built.agents.analyst?.getInstructions();
    assert.equal(typeof instructions, "string");
    assert.match(instructions, /call multiple tools in the same turn/i);
    assert.match(instructions, /later input depends on an earlier result/i);
  });

  it("binds an explicit Databricks workspace to the AppKit plugin context", async () => {
    const workspace = databricksWorkspace({
      assistantPaths: false,
      sandbox: false,
      tools: { requireApproval: false },
    });
    const built = await buildAgents({
      config: {
        agents: {
          analyst: {
            instructions: "Answer directly.",
            workspace,
          },
        },
      },
      context: { getPlugins: () => new Map() },
      log: log.logger("test/agents"),
    });

    const bound = await built.agents.analyst?.getWorkspace();
    assert.ok(bound);
    assert.notEqual(bound, workspace);
    assert.equal(bound.getToolsConfig()?.requireApproval, false);
  });

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
    assert.ok(
      processors?.some((processor) => "id" in processor && processor.id === "skill-search"),
    );
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
