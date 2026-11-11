import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  generatePythonNodeBindings,
  resolvePythonNodeBindingModule,
} from "../src/python-node-bindings.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
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

describe("resolvePythonNodeBindingModule", () => {
  it("resolves the namespace source relative to the package entrypoint", () => {
    const root = mkdtempSync(join(tmpdir(), "python-node-binding-module-"));
    temporaryDirectories.push(root);
    const nested = join(root, "src", "nested");
    mkdirSync(nested, { recursive: true });
    const entrypoint = join(root, "src", "index.ts");
    const module = join(nested, "functions.ts");
    writeFileSync(module, "export function run() {}\n");
    writeFileSync(
      entrypoint,
      "export /* comment */ * as functions\n  from './nested/functions.ts';\n",
    );

    assert.equal(resolvePythonNodeBindingModule(entrypoint, "functions"), realpathSync(module));
  });

  it("rejects missing namespace exports", () => {
    const root = mkdtempSync(join(tmpdir(), "python-node-binding-module-"));
    temporaryDirectories.push(root);
    const entrypoint = join(root, "index.ts");
    writeFileSync(entrypoint, "export const value = 1;\n");

    assert.throws(
      () => resolvePythonNodeBindingModule(entrypoint, "missing"),
      /does not export namespace missing/,
    );
  });
});
