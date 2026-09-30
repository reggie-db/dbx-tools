import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateBarrels } from "../barrels.ts";
import { root } from "../workspace.ts";
import { addExplicitInterfaceReexports, addTypeScriptExtensionsToBindingImports, makeDefaultedInterfaceParametersOptional } from "../uniffi.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "bazel-tooling-"));
  directories.push(directory);
  return directory;
}

describe("barrel freshness", () => {
  it("reports stale output without changing bytes or permissions", () => {
    const directory = temporary();
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@test/core", version: "1.0.0" }));
    writeFileSync(join(directory, "src/value.ts"), "export const numberValue = 1;\n");
    generateBarrels({ dirs: [directory] });
    const barrel = join(directory, "index.ts");
    const before = readFileSync(barrel, "utf8");
    const mode = statSync(barrel).mode;
    writeFileSync(join(directory, "src/new.ts"), "export const newValue = 2;\n");
    expect(() => generateBarrels({ dirs: [directory], check: true })).toThrow();
    expect(readFileSync(barrel, "utf8")).toBe(before);
    expect(statSync(barrel).mode).toBe(mode);
  });
});

describe("compiled package metadata", () => {
  it("keeps declaration paths and maps source exports without rewriting CSS", () => {
    const directory = temporary();
    const input = join(directory, "package.json");
    const output = join(directory, "npm/package.json");
    writeFileSync(input, JSON.stringify({ name: "@test/ui", exports: { ".": { types: "./lib/index.d.ts", default: "./lib/index.js" }, "./react": "./src/react/index.tsx", "./styles.css": "./src/styles.css" } }));
    const result = spawnSync(process.execPath, [join(root, "tools/bazel/package-manifest.mjs"), input, output]);
    expect(result.status).toBe(0);
    const metadata = JSON.parse(readFileSync(output, "utf8"));
    expect(metadata.exports["."].types).toBe("./lib/index.d.ts");
    expect(metadata.exports["./react"]).toEqual({ types: "./lib/src/react/index.d.ts", default: "./lib/src/react/index.js" });
    expect(metadata.exports["./styles.css"]).toBe("./src/styles.css");
  });
});

describe("UniFFI normalization", () => {
  it("repairs optional interface parameters from implementation defaults", () => {
    const source = "export interface AuthLike {\n  token(login: boolean): string;\n}\nclass Auth {\n  token(login: boolean = true): string {}\n}\n";
    expect(makeDefaultedInterfaceParametersOptional(source)).toContain("token(login?: boolean)");
  });
  it("uses explicit TypeScript extensions and interface exports", () => {
    expect(addTypeScriptExtensionsToBindingImports("export * from './_bindings';")).toContain("'./_bindings.ts'");
    expect(addExplicitInterfaceReexports("export * from './_bindings.ts';", [{ specifier: "./_bindings.ts", source: "export interface AuthLike {}" }])).toContain("export type { AuthLike }");
  });
});
