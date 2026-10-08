import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  affectedPythonNodeBindingProjects,
  generatePythonNodeBindings,
  type ResolvedPythonNodeBindings,
} from "../src/python-node-bindings.ts";

const ROOT = join(tmpdir(), "python-node-binding-watch");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Minimal resolved binding fixture for affected-project selection. */
function binding(
  project: string,
  packageName: string,
  workspaceDirectories: readonly string[],
  watchInputs: readonly string[],
): ResolvedPythonNodeBindings {
  const moduleDirectory = join(ROOT, project, "src", "fixture");
  return {
    bindingDirectory: join(moduleDirectory, "_generated", "node", packageName),
    bindingName: packageName,
    entrypoint: packageName,
    functionOverrides: [],
    moduleDirectory,
    modules: [],
    package: packageName,
    project,
    projectDirectory: join(ROOT, project),
    pyproject: join(ROOT, project, "pyproject.toml"),
    runtimeOutput: join(moduleDirectory, "_generated", "node", "_runtime.js"),
    watchInputs,
    workspaceDirectories,
  };
}

describe("affectedPythonNodeBindingProjects", () => {
  it("selects direct and transitive workspace source changes once per Python project", () => {
    const app = join(ROOT, "packages/app");
    const core = join(ROOT, "packages/core");
    const configs = [
      binding(
        "python/app",
        "app",
        [app, core],
        [join(app, "src/app.ts"), join(core, "src/options.ts")],
      ),
      binding("python/app", "core", [core], [join(core, "src/options.ts")]),
      binding(
        "python/other",
        "other",
        [join(ROOT, "packages/other")],
        [join(ROOT, "packages/other/src/index.ts")],
      ),
    ];

    assert.deepEqual(
      affectedPythonNodeBindingProjects(ROOT, configs, [
        join(app, "src/app.ts"),
        join(core, "src/options.ts"),
      ]),
      ["python/app"],
    );
  });

  it("keeps unrelated changes on the no-lock path", () => {
    const app = join(ROOT, "packages/app");
    const configs = [binding("python/app", "app", [app], [join(app, "src/index.ts")])];

    assert.deepEqual(
      affectedPythonNodeBindingProjects(ROOT, configs, [join(ROOT, "README.md")]),
      [],
    );
  });

  it("ignores tests and unrelated modules in a configured package", () => {
    const app = join(ROOT, "packages/app");
    const configs = [binding("python/app", "app", [app], [join(app, "src/bindings.ts")])];

    assert.deepEqual(
      affectedPythonNodeBindingProjects(ROOT, configs, [
        join(app, "test/bindings.test.ts"),
        join(app, "src/unrelated.ts"),
        join(app, "lib/bindings.js"),
      ]),
      [],
    );
  });
});

describe("generatePythonNodeBindings", () => {
  it("fails check mode when an unconfigured generated directory remains", () => {
    const root = mkdtempSync(join(tmpdir(), "python-node-binding-check-"));
    temporaryDirectories.push(root);
    const stale = join(root, "python/pkg/src/fixture/_generated/node");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "stale.py"), "stale = True\n");

    assert.throws(
      () => generatePythonNodeBindings(root, { check: true }),
      /Generated Node binding directories are stale/,
    );
    generatePythonNodeBindings(root);
    assert.throws(() => writeFileSync(join(stale, "still-present"), ""), /ENOENT/);
  });
});
