/**
 * Skill folders are the mapping a consuming app configures, so the cases here
 * pin the two halves it depends on: what the built-in names resolve to, and how
 * a consumer's map merges over them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RequestContext } from "@mastra/core/request-context";

import { MASTRA_USER_EMAIL_KEY } from "../src/config.ts";
import { ASSISTANT_SHARED_SKILLS_PATH } from "../src/skill-paths.ts";
import {
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
