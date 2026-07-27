/**
 * `applyToProjects` selection filters. Every filter is AND-ed, globs may be
 * negated with `!`, and the default selection is DBXTools CHILD projects only -
 * `includeNonDBXToolsProjects` / `includeRoots` are the two opt-in wideners.
 *
 * Selection happens at CALL time (`construct.with(...)` walks the subtree), so
 * these assert without synthesizing.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Project } from "projen";
import { applyToProjects, DBXToolsNodeProject, DBXToolsTypeScriptProject } from "../src/project";

let outdir: string;
let root: DBXToolsNodeProject;

/** Names of the projects a given options object selects, sorted for stable compare. */
const selected = (options?: Parameters<typeof applyToProjects>[1]): string[] => {
  const hits: string[] = [];
  const collect = (p: Project) => hits.push(p.name);
  if (options === undefined) applyToProjects(root, collect);
  else applyToProjects(root, options as never, collect as never);
  return hits.sort();
};

before(() => {
  process.env.PROJEN_DISABLE_POST = "1"; // no install/barrels during construction
  outdir = mkdtempSync(join(tmpdir(), "apply-to-projects-"));

  root = new DBXToolsNodeProject({
    name: "apply-fixture",
    scope: "fixture",
    outdir,
    defaultTagMixins: false,
  });
  new DBXToolsTypeScriptProject({
    parent: root,
    outdir: "workspaces/ui/app",
    name: "@fixture/ui-app",
  });
  new DBXToolsTypeScriptProject({
    parent: root,
    outdir: "workspaces/shared/core",
    name: "@other/shared-core",
  });
  // A plain projen project, to prove the DBXTools-only default excludes it.
  new Project({ name: "plain-child", parent: root, outdir: "workspaces/plain" });
});

after(() => {
  rmSync(outdir, { recursive: true, force: true });
});

describe("applyToProjects selection", () => {
  it("defaults to DBXTools children only - no roots, no plain projects", () => {
    assert.deepEqual(selected(), ["@fixture/ui-app", "@other/shared-core"]);
  });

  it("includeNonDBXToolsProjects widens to plain projen projects", () => {
    assert.deepEqual(selected({ includeNonDBXToolsProjects: true }), [
      "@fixture/ui-app",
      "@other/shared-core",
      "plain-child",
    ]);
  });

  it("includeRoots adds the parentless tree root", () => {
    assert.ok(selected({ includeRoots: true }).includes("apply-fixture"));
  });

  it("filters on the raw projen name", () => {
    assert.deepEqual(selected({ name: "@fixture/*" }), ["@fixture/ui-app"]);
  });

  it("filters on the parsed full npm name", () => {
    assert.deepEqual(selected({ identifierPackageName: "*/shared-core" }), ["@other/shared-core"]);
  });

  it("filters on the parsed npm scope", () => {
    assert.deepEqual(selected({ identifierScope: "other" }), ["@other/shared-core"]);
  });

  it("filters on the parsed unscoped name, and honours a negated glob", () => {
    assert.deepEqual(selected({ identifierName: "ui-app" }), ["@fixture/ui-app"]);
    assert.deepEqual(selected({ identifierName: "!ui-app" }), ["@other/shared-core"]);
  });

  it("filters on the root-relative folder path", () => {
    assert.deepEqual(selected({ path: "workspaces/ui/**" }), ["@fixture/ui-app"]);
  });

  it("ANDs every provided filter", () => {
    assert.deepEqual(selected({ identifierScope: "fixture", path: "workspaces/ui/**" }), [
      "@fixture/ui-app",
    ]);
    // Same path, a scope that does not match there - AND yields nothing.
    assert.deepEqual(selected({ identifierScope: "other", path: "workspaces/ui/**" }), []);
  });
});
