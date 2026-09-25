/**
 * Skill folders are the mapping a consuming app configures, so the cases here
 * pin the two halves it depends on: what the built-in names resolve to, and how
 * a consumer's map merges over them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { log } from "@dbx-tools/shared-core";
import { RequestContext } from "@mastra/core/request-context";
import type { WorkspaceSandbox } from "@mastra/core/workspace";

import { buildAgents } from "../src/agents.ts";
import { MASTRA_USER_EMAIL_KEY, MASTRA_USER_KEY } from "../src/config.ts";
import { MontySandbox } from "../src/monty-sandbox.ts";
import { DatabricksSandbox } from "../src/sandbox.ts";
import { ASSISTANT_SHARED_SKILLS_PATH } from "../src/skill-paths.ts";
import {
  createWorkspace,
  DEFAULT_SKILL_FOLDERS,
  resolveSkillFolders,
  type SkillFolderOptions,
} from "../src/workspaces.ts";

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
  it("uses a per-user Databricks sandbox by default", async () => {
    const workspace = createWorkspace({ assistantSkills: false, id: "analyst" });
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_USER_KEY, {
      id: "user-1",
      executionContext: { client: {} },
    });

    const first = await workspace.resolveSandbox({ requestContext });
    const second = await workspace.resolveSandbox({ requestContext });

    assert.ok(first instanceof DatabricksSandbox);
    assert.equal(first.provider, "databricks");
    assert.match(first.id, /^mastra-[a-f0-9]{32}$/);
    assert.equal(first, second);
  });

  it("can disable or replace the Databricks default explicitly", async () => {
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

    const monty = createWorkspace({ assistantSkills: false, sandbox: "monty" });
    assert.ok(
      (await monty.resolveSandbox({ requestContext: new RequestContext() })) instanceof
        MontySandbox,
    );
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
});
