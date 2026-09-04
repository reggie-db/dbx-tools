import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DBXToolsNodeProject,
  DBXToolsRustWorkspace,
  DBXToolsTypeScriptProject,
} from "../src/project.ts";

interface TaskStep {
  spawn?: string;
  exec?: string;
  // projen renders a step built with `execArgs` as this array, NOT as `exec`, so
  // a check that only reads `exec` silently passes on an argv-form step.
  execArgs?: string[];
  cwd?: string;
  condition?: string;
}

interface TaskManifest {
  tasks: Record<string, { steps?: TaskStep[] }>;
}

function synthTasks(): { root: TaskManifest; child: TaskManifest } {
  process.env.PROJEN_DISABLE_POST = "1";
  const outdir = mkdtempSync(join(tmpdir(), "workspace-tasks-"));
  const root = new DBXToolsNodeProject({
    name: "workspace-tasks-fixture",
    outdir,
    defaultTagMixins: false,
    extraWorkspaceMembers: ["tooling"],
  });
  new DBXToolsTypeScriptProject({
    parent: root,
    outdir: "packages/member",
    name: "@fixture/member",
  });
  root.synth();

  const read = (path: string): TaskManifest =>
    JSON.parse(readFileSync(path, "utf8")) as TaskManifest;
  return {
    root: read(join(outdir, ".projen/tasks.json")),
    child: read(join(outdir, "packages/member/.projen/tasks.json")),
  };
}

describe("workspace validation tasks", () => {
  const tasks = synthTasks();

  // A projen monorepo root gets EMPTY compile/test tasks, so `bun run build`
  // validated nothing. The root now delegates to bun's workspace filter instead
  // of emitting one `exec` per member: bun runs them in parallel, skips a member
  // that lacks the script, and reads the member list from `package.json` (so a
  // new package needs no re-synth to be covered).
  it("delegates root compile and test to every workspace member", () => {
    assert.deepEqual(
      tasks.root.tasks.compile.steps?.map((step) => step.exec),
      ["bun run --filter '*' compile"],
    );
    assert.deepEqual(
      tasks.root.tasks.test.steps?.map((step) => step.exec ?? `spawn:${step.spawn}`),
      ["spawn:eslint", "bun run --filter '*' test"],
    );
  });

  it("checks lint without mutating and exposes fixes explicitly", () => {
    const lintCommand = tasks.root.tasks.eslint.steps?.[0]?.exec ?? "";
    const fixCommand = tasks.root.tasks["eslint:fix"].steps?.[0]?.exec ?? "";
    assert.doesNotMatch(lintCommand, /--fix/);
    assert.match(lintCommand, /\bpackages\b/);
    assert.match(lintCommand, /\bprojen$/);
    assert.equal(fixCommand, "bun run eslint -- --fix");
  });

  // `*` selects workspace MEMBERS only. If it matched the root the delegating
  // step would re-enter itself, so a root fan-out must never name the root.
  it("cannot recurse into the root task that delegates", () => {
    for (const task of [tasks.root.tasks.compile, tasks.root.tasks.test]) {
      for (const step of task.steps ?? []) {
        assert.notEqual(step.spawn, "compile");
        assert.notEqual(step.spawn, "test");
        assert.equal(step.cwd, undefined);
      }
    }
  });

  // Members outside the scanned package roots (the engine's own `projen/` dir)
  // are workspace members too, so the filter must be all that is needed - no
  // per-member step, and no member list baked into the task.
  it("needs no per-member step for a standalone workspace member", () => {
    const steps = [
      ...(tasks.root.tasks.compile.steps ?? []),
      ...(tasks.root.tasks.test.steps ?? []),
    ];
    assert.equal(
      steps.some((step) => step.exec?.includes("tooling") || step.cwd === "tooling"),
      false,
    );
  });

  // A root build is validation, not a release artifact fan-out. A child build is
  // intentionally more flexible: run it directly and projen performs the full
  // compile/test/pack lifecycle for that one package. Root bump remains separate
  // and calls filtered compile + `bun publish --ignore-scripts` itself.
  it("omits root packing but keeps per-package builds complete", () => {
    assert.deepEqual(tasks.root.tasks.package?.steps ?? [], []);

    const childPackageCommands = (tasks.child.tasks.package?.steps ?? []).map(
      (step) => step.exec ?? (step.execArgs ?? []).join(" "),
    );
    const pack = childPackageCommands.find((command) => /\b(npm|pnpm|bun) pack\b/.test(command));
    assert.ok(pack);
    assert.match(pack, /--ignore-scripts/);
  });

  it("does not swallow package test failures", () => {
    const command = tasks.child.tasks.test.steps?.find((step) => step.exec)?.exec ?? "";
    const condition = tasks.child.tasks.test.steps?.find((step) => step.exec)?.condition ?? "";
    assert.equal(command, "bun test test");
    assert.match(condition, /^find test /);
  });
});

describe("Rust sync tasks", () => {
  it("records no Rust watcher state when no crates exist", () => {
    process.env.PROJEN_DISABLE_POST = "1";
    const outdir = mkdtempSync(join(tmpdir(), "workspace-no-rust-"));
    const root = new DBXToolsNodeProject({
      name: "workspace-no-rust",
      outdir,
      defaultTagMixins: false,
      github: false,
    });
    const rust = new DBXToolsRustWorkspace(root, { scope: "fixture" });
    root.dbxToolsConfig.rust = rust.workspaceMapping;
    root.synth();
    const manifest = JSON.parse(readFileSync(join(outdir, "package.json"), "utf8")) as {
      dbxToolsConfig?: { rust?: { crates?: string[] } };
    };
    assert.deepEqual(manifest.dbxToolsConfig?.rust?.crates, []);
  });
});
