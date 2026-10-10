/**
 * Workspace installs belong to the custom root.
 *
 * Projen gives every child NodePackage a post-synth install hook. In a single
 * Bun workspace those hooks all run the same root install, producing one
 * `bun install` per package. The root mixin clears child install tasks by
 * default while retaining an explicit opt-out.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DBXToolsNodeProject, DBXToolsTypeScriptProject } from "../src/project.ts";

let temp: string;

/** Synth one root plus a child attached after root construction. */
function synthFixture(
  name: string,
  rootInstallOnly?: boolean,
  childRootInstallOnly?: boolean,
  customizeChildInstall = false,
): {
  readonly child: DBXToolsTypeScriptProject;
  readonly outdir: string;
  readonly root: DBXToolsNodeProject;
} {
  const outdir = join(temp, name);
  const root = new DBXToolsNodeProject({
    name,
    outdir,
    defaultTagMixins: false,
    ...(rootInstallOnly !== undefined ? { rootInstallOnly } : {}),
  });
  const child = new DBXToolsTypeScriptProject({
    parent: root,
    outdir: "packages/child",
    name: `@fixture/${name}-child`,
    ...(childRootInstallOnly !== undefined ? { rootInstallOnly: childRootInstallOnly } : {}),
  });
  if (customizeChildInstall) child.package.installTask.exec("echo custom install");
  root.synth();
  return { child, outdir, root };
}

/** Steps generated for task `name` in a project directory. */
function taskSteps(outdir: string, name: string): Array<{ exec?: string }> {
  const tasks = JSON.parse(readFileSync(join(outdir, ".projen", "tasks.json"), "utf8")) as {
    tasks: Record<string, { steps: Array<{ exec?: string }> }>;
  };
  return tasks.tasks[name]?.steps ?? [];
}

before(() => {
  process.env.PROJEN_DISABLE_POST = "1";
  temp = mkdtempSync(join(tmpdir(), "root-install-"));
});

after(() => {
  delete process.env.PROJEN_DISABLE_POST;
  rmSync(temp, { recursive: true, force: true });
});

describe("ROOT_INSTALL_ONLY_MIXIN", () => {
  it("keeps root installs and suppresses late-attached child installs by default", () => {
    const { child, outdir, root } = synthFixture("default");

    assert.ok(taskSteps(outdir, "install").length > 0);
    assert.ok(taskSteps(outdir, "install:ci").length > 0);
    assert.deepEqual(taskSteps(join(outdir, "packages/child"), "install"), []);
    assert.deepEqual(taskSteps(join(outdir, "packages/child"), "install:ci"), []);
    assert.equal(Object.hasOwn(root.package, "installDependencies"), false);
    assert.equal(Object.hasOwn(child.package, "installDependencies"), true);
  });

  it("preserves child install tasks when rootInstallOnly is false", () => {
    const { child, outdir } = synthFixture("opt-out", false);

    assert.ok(taskSteps(join(outdir, "packages/child"), "install").length > 0);
    assert.ok(taskSteps(join(outdir, "packages/child"), "install:ci").length > 0);
    assert.equal(Object.hasOwn(child.package, "installDependencies"), false);
  });

  it("preserves one child's native lifecycle when that child opts out", () => {
    const { child, outdir } = synthFixture("child-opt-out", undefined, false);

    assert.ok(taskSteps(join(outdir, "packages/child"), "install").length > 0);
    assert.ok(taskSteps(join(outdir, "packages/child"), "install:ci").length > 0);
    assert.equal(Object.hasOwn(child.package, "installDependencies"), false);
  });

  it("preserves a child lifecycle when an install task has custom steps", () => {
    const { child, outdir } = synthFixture("custom-install", undefined, undefined, true);
    const steps = taskSteps(join(outdir, "packages/child"), "install");

    assert.equal(steps.length, 2);
    assert.equal(steps[1]?.exec, "echo custom install");
    assert.equal(Object.hasOwn(child.package, "installDependencies"), false);
  });
});
