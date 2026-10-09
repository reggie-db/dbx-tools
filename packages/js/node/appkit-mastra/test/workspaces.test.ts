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
import { log } from "@dbx-tools/shared-core";
import { MemoryFileSystem } from "@dbx-tools/shared-fs";
import { RequestContext } from "@mastra/core/request-context";
import type { WorkspaceSandbox } from "@mastra/core/workspace";

import { buildAgents } from "../src/agents.ts";
import { MASTRA_SCOPES_KEY, MASTRA_USER_EMAIL_KEY, MASTRA_USER_KEY } from "../src/config.ts";
import { filesystems } from "../src/filesystems.ts";
import { MontySandbox } from "../src/monty-sandbox.ts";
import { DatabricksSandbox } from "../src/sandbox.ts";
import { ASSISTANT_SHARED_SKILLS_PATH } from "../src/skill-paths.ts";
import {
  createWorkspace,
  DEFAULT_SKILL_FOLDERS,
  resolveSkillFolders,
  workspaceSkillCatalogueResolver,
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

describe("DEFAULT_SKILL_FOLDERS", () => {
  it("maps workspace-team to the shared tree, readable but not writable", async () => {
    const folder = DEFAULT_SKILL_FOLDERS["workspace-team"];
    assert.equal(await resolvePath(folder), ASSISTANT_SHARED_SKILLS_PATH);
    assert.equal(folder.readable, true);
    assert.equal(folder.writable, false);
  });

  it("maps workspace-team-app to the requesting user's tree, writable", async () => {
    const folder = DEFAULT_SKILL_FOLDERS["workspace-team-app"];
    assert.equal(folder.readable, true);
    assert.equal(folder.writable, true);

    const requestContext = new RequestContext();
    requestContext.set(MASTRA_USER_EMAIL_KEY, " user@example.com ");
    assert.equal(
      await resolvePath(folder, requestContext),
      "/Users/user@example.com/.assistant/skills",
    );
  });

  it("skips workspace-team-app when the request carries no user email", async () => {
    const folder = DEFAULT_SKILL_FOLDERS["workspace-team-app"];
    assert.equal(await resolvePath(folder), undefined);
    assert.equal(await resolvePath(folder, new RequestContext()), undefined);
  });
});

describe("resolveSkillFolders", () => {
  it("returns the built-in defaults when nothing is configured", () => {
    assert.deepEqual(Object.keys(resolveSkillFolders()).sort(), [
      "workspace-team",
      "workspace-team-app",
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
      skillFolders: { "workspace-team": { path: "/Workspace/Shared/team-skills", writable: true } },
    });
    assert.equal(resolved["workspace-team"]?.path, "/Workspace/Shared/team-skills");
    assert.equal(resolved["workspace-team"]?.writable, true);
    assert.ok(resolved["workspace-team-app"]);
  });

  it("disables a default with false", () => {
    assert.deepEqual(
      Object.keys(resolveSkillFolders({ skillFolders: { "workspace-team-app": false } })),
      ["workspace-team"],
    );
  });

  it("adds a consumer-defined folder alongside the defaults", () => {
    const resolved = resolveSkillFolders({
      skillFolders: { runbooks: { path: "/Workspace/Shared/runbooks" } },
    });
    assert.deepEqual(Object.keys(resolved).sort(), [
      "runbooks",
      "workspace-team",
      "workspace-team-app",
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
  it("reuses a resolved filesystem for the same Mastra user scope", async () => {
    const mount = filesystems(new MemoryFileSystem({ root: "/skills" }));
    const workspace = createWorkspace({
      assistantSkills: false,
      sandbox: false,
      mounts: [
        ({ requestContext }) => ({
          mounts: { "/skills": mount },
          skillPaths: ["/skills"],
          cacheKey: requestContext?.get("resolved-user") as string,
        }),
      ],
    });
    const firstContext = new RequestContext();
    firstContext.set("resolved-user", "user-1");
    const secondContext = new RequestContext();
    secondContext.set("resolved-user", "user-1");
    const otherContext = new RequestContext();
    otherContext.set("resolved-user", "user-2");

    const first = await workspace.resolveFilesystem({ requestContext: firstContext });
    const second = await workspace.resolveFilesystem({ requestContext: secondContext });
    const other = await workspace.resolveFilesystem({ requestContext: otherContext });

    assert.equal(first, second);
    assert.notEqual(first, other);
  });

  it("prefers a team skill over a same-named app-user skill", async () => {
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
        "workspace-team": {
          filesystem: filesystems(team),
          mount: "/workspace-team",
        },
        "workspace-team-app": {
          filesystem: filesystems(app),
          mount: "/workspace-team-app",
          writable: true,
        },
      },
    });
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_SCOPES_KEY, ["workspace"]);
    const catalogue = await (
      await workspaceSkillCatalogueResolver(workspace)!({ requestContext })
    ).get();

    assert.deepEqual(catalogue.skills.map(({ name }) => name).sort(), [
      "databricks-jobs",
      "personal-runbook",
    ]);
    assert.equal(
      catalogue.skills.find(({ name }) => name === "databricks-jobs")?.instructions,
      "Team instructions",
    );
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
      const catalogue = await (
        await workspaceSkillCatalogueResolver(workspace)!({
          requestContext: new RequestContext(),
        })
      ).get();

      assert.deepEqual(catalogue.skills.map(({ name }) => name), ["databricks-apps"]);
    } finally {
      await rm(root, { recursive: true, force: true });
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

  it("uses catalogue-backed on-demand skill discovery by default", async () => {
    const built = await buildAgents({
      config: {},
      context: undefined,
      log: log.logger("test/agents"),
    });

    const processors = await built.agents[built.defaultAgentId]?.listConfiguredInputProcessors();
    assert.ok(
      processors?.some(
        (processor) => "id" in processor && processor.id === "skill-catalogue-search",
      ),
    );
  });

  it("can retain Mastra's eager skill catalogue explicitly", async () => {
    const built = await buildAgents({
      config: { workspaceSkillSearch: false },
      context: undefined,
      log: log.logger("test/agents"),
    });

    const processors = await built.agents[built.defaultAgentId]?.listConfiguredInputProcessors();
    assert.ok(
      processors?.every(
        (processor) => !("id" in processor) || processor.id !== "skill-catalogue-search",
      ),
    );
  });
});
