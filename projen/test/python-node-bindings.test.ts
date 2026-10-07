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
    workspaceDirectories,
  };
}

describe("affectedPythonNodeBindingProjects", () => {
  it("selects direct and transitive workspace source changes once per Python project", () => {
    const app = join(ROOT, "packages/app");
    const core = join(ROOT, "packages/core");
    const configs = [
      binding("python/app", "app", [app, core]),
      binding("python/app", "core", [core]),
      binding("python/other", "other", [join(ROOT, "packages/other")]),
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
    const configs = [binding("python/app", "app", [join(ROOT, "packages/app")])];

    assert.deepEqual(
      affectedPythonNodeBindingProjects(ROOT, configs, [join(ROOT, "README.md")]),
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
