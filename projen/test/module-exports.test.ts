import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { publicNamespaceExports } from "../src/module-exports.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("publicNamespaceExports", () => {
  it("returns namespace names and source specifiers across valid syntax variations", () => {
    const directory = mkdtempSync(join(tmpdir(), "module-exports-"));
    temporaryDirectories.push(directory);
    const entrypoint = join(directory, "index.ts");
    writeFileSync(
      entrypoint,
      [
        'export /* before star */ * /* before as */ as alpha from "./alpha.ts";',
        "export * as beta",
        "  from './nested/beta.ts';",
        'export * from "./unnamed.ts";',
      ].join("\n"),
    );

    assert.deepEqual(publicNamespaceExports(entrypoint), [
      { name: "alpha", source: "./alpha.ts" },
      { name: "beta", source: "./nested/beta.ts" },
    ]);
  });

  it("returns no namespaces for missing or non-namespace files", () => {
    const directory = mkdtempSync(join(tmpdir(), "module-exports-"));
    temporaryDirectories.push(directory);
    const entrypoint = join(directory, "index.ts");
    writeFileSync(entrypoint, "export const value = 1;\n");

    assert.deepEqual(publicNamespaceExports(entrypoint), []);
    assert.deepEqual(publicNamespaceExports(join(directory, "missing.ts")), []);
  });
});
