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
function synthFixture(name: string, rootInstallOnly?: boolean): string {
  const outdir = join(temp, name);
  const root = new DBXToolsNodeProject({
    name,
    outdir,
    defaultTagMixins: false,
    ...(rootInstallOnly !== undefined ? { rootInstallOnly } : {}),
  });
  new DBXToolsTypeScriptProject({
    parent: root,
    outdir: "packages/child",
    name: `@fixture/${name}-child`,
  });
  root.synth();
  return outdir;
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
  it("keeps root installs and clears late-attached child installs by default", () => {
    const outdir = synthFixture("default");

    assert.ok(taskSteps(outdir, "install").length > 0);
    assert.ok(taskSteps(outdir, "install:ci").length > 0);
    assert.deepEqual(taskSteps(join(outdir, "packages/child"), "install"), []);
    assert.deepEqual(taskSteps(join(outdir, "packages/child"), "install:ci"), []);
  });

  it("preserves child install tasks when rootInstallOnly is false", () => {
    const outdir = synthFixture("opt-out", false);

    assert.ok(taskSteps(join(outdir, "packages/child"), "install").length > 0);
    assert.ok(taskSteps(join(outdir, "packages/child"), "install:ci").length > 0);
  });

  it("suppresses child install hooks and their trigger logs", () => {
    const outdir = join(temp, "hooks");
    const root = new DBXToolsNodeProject({
      name: "hooks",
      outdir,
      defaultTagMixins: false,
    });
    const child = new DBXToolsTypeScriptProject({
      parent: root,
      outdir: "packages/child",
      name: "@fixture/hooks-child",
    });
    const nodePackage = child.package as unknown as {
      installDependencies(trigger: unknown): void;
      logInstallTrigger(trigger: unknown): void;
    };
    let installs = 0;
    let logs = 0;
    nodePackage.installDependencies = () => installs++;
    nodePackage.logInstallTrigger = () => logs++;

    root.synth();
    nodePackage.logInstallTrigger({});
    nodePackage.installDependencies({});

    assert.equal(logs, 0);
    assert.equal(installs, 0);
  });
});
