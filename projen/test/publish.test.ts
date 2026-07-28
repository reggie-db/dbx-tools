/**
 * The compiled publish surface.
 *
 * Packages resolve each other from SOURCE in the workspace, but a published
 * tarball has to hand Node real JavaScript - so `publishConfig` carries a second
 * entry-point map that pnpm substitutes at pack time. These assert the mapping
 * itself, plus the two ways it is easy to get wrong: clobbering the `access`
 * projen renders into the same field, and compiling a UI package whose exports
 * include assets that `tsc` neither emits nor rewrites.
 *
 * `applyCompiledPublish` reads the FINAL exports map, so these synthesize.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { applyExports, DBXToolsNodeProject, DBXToolsTypeScriptProject } from "../src/project";

let outdir: string;

/** The synthesized manifest of a package, by its outdir. */
const manifest = (dir: string): Record<string, any> =>
  JSON.parse(readFileSync(join(outdir, dir, "package.json"), "utf8"));

before(() => {
  process.env.PROJEN_DISABLE_POST = "1"; // no install/barrels during synth
  outdir = mkdtempSync(join(tmpdir(), "publish-"));

  const root = new DBXToolsNodeProject({
    name: "publish-fixture",
    scope: "fixture",
    outdir,
    defaultTagMixins: false,
  });

  // A node package carrying subpaths and a non-TypeScript entry, to pin both
  // the positional `src/` mapping and the pass-through.
  const node = new DBXToolsTypeScriptProject({
    parent: root,
    outdir: "packages/node/thing",
    name: "@fixture/thing",
  });
  node.dbxToolsConfig.tags.push("node");
  applyExports(node, {
    ".": "./index.ts",
    "./deep": "./src/nested/deep.ts",
    "./package.json": "./package.json",
  });

  // A UI package: excluded, because its consumer is always a bundler and its
  // exports include a stylesheet tsc would neither emit nor rewrite.
  const ui = new DBXToolsTypeScriptProject({
    parent: root,
    outdir: "packages/ui/app",
    name: "@fixture/ui-app",
  });
  ui.dbxToolsConfig.tags.push("ui");
  applyExports(ui, {
    "./react": "./src/react/index.ts",
    "./styles.css": "./src/styles.css",
  });

  root.synth();
});

after(() => {
  rmSync(outdir, { recursive: true, force: true });
});

describe("compiled publish surface", () => {
  it("keeps the WORKSPACE exports pointed at source", () => {
    // The whole point of the split: in-repo, a cross-package import still
    // resolves to `.ts` so packages type-check with no build step.
    assert.deepEqual(manifest("packages/node/thing").exports, {
      ".": "./index.ts",
      "./deep": "./src/nested/deep.ts",
      "./package.json": "./package.json",
    });
  });

  it("maps every TypeScript entry onto its emitted twin, positionally", () => {
    // `rootDir: "."` makes the emitted tree mirror the package layout, so the
    // mapping is a path prefix - not a flattening.
    assert.deepEqual(manifest("packages/node/thing").publishConfig.exports, {
      ".": { types: "./lib/index.d.ts", default: "./lib/index.js" },
      "./deep": { types: "./lib/src/nested/deep.d.ts", default: "./lib/src/nested/deep.js" },
      "./package.json": "./package.json",
    });
  });

  it("advertises the compiled root through the legacy fields too", () => {
    const { publishConfig } = manifest("packages/node/thing");
    assert.equal(publishConfig.main, "./lib/index.js");
    assert.equal(publishConfig.types, "./lib/index.d.ts");
  });

  it("preserves the access projen renders into the same field", () => {
    // Setting `publishConfig` REPLACES it wholesale, and projen puts `access`
    // there from `npmAccess`. Losing it publishes a scoped package restricted.
    assert.equal(manifest("packages/node/thing").publishConfig.access, "public");
  });

  it("ships the emitted output alongside the source", () => {
    const { files } = manifest("packages/node/thing");
    assert.ok(files.includes("lib"), "lib must be in the tarball allowlist");
    assert.ok(files.includes("index.ts"), "source still ships");
  });

  it("leaves UI packages publishing source", () => {
    const ui = manifest("packages/ui/app");
    assert.equal(ui.publishConfig?.main, undefined, "no compiled entry point");
    assert.deepEqual(ui.exports, {
      "./react": "./src/react/index.ts",
      "./styles.css": "./src/styles.css",
    });
    assert.ok(!(ui.files ?? []).includes("lib"), "nothing compiled to ship");
  });

  it("compiles the package-root barrel, which projen's default rootDir excludes", () => {
    // Without this the emitted tree has no `index.js` at all and every `.`
    // export in publishConfig points at a file that was never written.
    // projen prefixes its tsconfig with a generated-file banner, so this is
    // JSONC rather than JSON.
    const tsconfig = JSON.parse(
      readFileSync(join(outdir, "packages/node/thing/tsconfig.json"), "utf8").replace(
        /^\s*\/\/.*$/gm,
        "",
      ),
    );
    assert.equal(tsconfig.compilerOptions.rootDir, ".");
    assert.ok(tsconfig.include.includes("index.ts"));
  });
});
