import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { planSyncChanges, syncSnapshot } from "../tasks/sync.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): {
  readonly root: string;
  readonly packageDirectory: string;
  readonly source: string;
} {
  const root = mkdtempSync(join(tmpdir(), "projen-sync-"));
  temporaryDirectories.push(root);
  const packageDirectory = join(root, "packages/js/example");
  const source = join(packageDirectory, "src/example.ts");
  mkdirSync(join(packageDirectory, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "fixture",
      dbxToolsConfig: {
        packageRoots: ["packages/js"],
        syncResynthPaths: ["branding", "projen/src"],
        pythonNodeRuntimeDirectory: "packages/py/node-runtime",
      },
    })}\n`,
  );
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/js/example"\n');
  writeFileSync(
    join(packageDirectory, "package.json"),
    '{"name":"@fixture/example","version":"1.0.0"}\n',
  );
  writeFileSync(source, "export const value = 1;\n");
  return { root, packageDirectory, source };
}

describe("focused sync planning", () => {
  it("updates only an existing package barrel for an ordinary source edit", () => {
    const { root, packageDirectory, source } = fixture();
    const plan = planSyncChanges(syncSnapshot(root), [source]);

    assert.equal(plan.action, "focused");
    assert.deepEqual(plan.barrelDirectories, [resolve(packageDirectory)]);
    assert.equal(plan.bindings, false);
    assert.equal(plan.runtime, false);
  });

  it("refreshes bindings when a changed package participates in their source graph", () => {
    const { root, packageDirectory, source } = fixture();
    const snapshot = syncSnapshot(root);
    const plan = planSyncChanges({ ...snapshot, bindingDirectories: [resolve(packageDirectory)] }, [
      source,
    ]);

    assert.equal(plan.action, "focused");
    assert.equal(plan.bindings, true);
    assert.deepEqual(plan.barrelDirectories, [resolve(packageDirectory)]);
  });

  it("runs the runtime builder without full synthesis for runtime-owner edits", () => {
    const { root } = fixture();
    const shim = join(root, "packages/py/node-runtime/shims/fs.ts");
    const plan = planSyncChanges(syncSnapshot(root), [shim]);

    assert.equal(plan.action, "focused");
    assert.equal(plan.runtime, true);
    assert.equal(plan.bindings, false);
  });

  it("resynthesizes only for configured inputs and package topology changes", () => {
    const { root } = fixture();
    const snapshot = syncSnapshot(root);
    const configured = planSyncChanges(snapshot, [join(root, "projen/src/project-js.ts")]);
    assert.equal(configured.action, "synthesize");
    assert.deepEqual(configured.reasons, ["projen/src"]);

    const added = join(root, "packages/js/added/src/added.ts");
    mkdirSync(join(root, "packages/js/added/src"), { recursive: true });
    writeFileSync(added, "export const added = true;\n");
    const topology = planSyncChanges(snapshot, [added]);
    assert.equal(topology.action, "synthesize");
    assert.deepEqual(topology.reasons, ["package topology"]);
  });

  it("ignores unrelated Python changes without a barrel warning or synthesis", () => {
    const { root } = fixture();
    const plan = planSyncChanges(syncSnapshot(root), [
      join(root, "packages/py/example/src/app.py"),
    ]);

    assert.equal(plan.action, "ignore");
    assert.deepEqual(plan.barrelDirectories, []);
    assert.equal(plan.bindings, false);
    assert.equal(plan.runtime, false);
  });
});
