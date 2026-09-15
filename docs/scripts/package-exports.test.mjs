import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePackageTypeScriptExports } from "./package-exports.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function packageFixture(manifest, files = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dbx-tools-package-exports-"));
  temporaryDirectories.push(directory);
  for (const file of files) {
    const destination = path.join(directory, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, "export const value = true;\n");
  }
  const manifestPath = path.join(directory, "package.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

describe("resolvePackageTypeScriptExports", () => {
  test("resolves root, subpath, and conditional TypeScript targets", () => {
    const manifest = packageFixture(
      {
        name: "@scope/example",
        exports: {
          ".": {
            types: "./src/index.ts",
            default: "./dist/index.js",
          },
          "./browser": [{ types: "./missing/browser.d.ts" }, { import: "./src/browser.ts" }],
          "./styles.css": "./src/styles.css",
          "./package.json": "./package.json",
        },
      },
      ["src/index.ts", "src/browser.ts", "src/styles.css"],
    );

    expect(resolvePackageTypeScriptExports(manifest)).toEqual([
      expect.objectContaining({
        subpath: ".",
        importPath: "@scope/example",
        target: "./src/index.ts",
      }),
      expect.objectContaining({
        subpath: "./browser",
        importPath: "@scope/example/browser",
        target: "./src/browser.ts",
      }),
    ]);
  });

  test("rejects targets outside the package", () => {
    const manifest = packageFixture({
      name: "@scope/example",
      exports: { ".": "./../outside.ts" },
    });

    expect(() => resolvePackageTypeScriptExports(manifest)).toThrow("escapes its package");
  });

  test("uses only the published ui-mastra React entry", () => {
    const manifest = path.resolve("packages/js/ui/mastra/package.json");

    expect(
      resolvePackageTypeScriptExports(manifest).map(({ subpath, relativeFile }) => ({
        subpath,
        relativeFile,
      })),
    ).toEqual([{ subpath: "./react", relativeFile: "src/react/index.ts" }]);
  });
});
