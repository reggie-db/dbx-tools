/**
 * The generated `vite.config.ts` and its override chain.
 *
 * The generated file is projen-owned and read-only, so a package tunes Vite
 * through an unmanaged override module beside it. That override may be written in
 * TypeScript: the generated config imports a runtime-computed URL, which Vite's
 * config bundling cannot inline, so Node executes it and strips the types itself.
 * The chain order is what makes the merge predictable, so both are asserted.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DBXToolsNodeProject, DBXToolsTypeScriptProject } from "../src/project.ts";
import { PACKAGE_TAG_MIXINS } from "../src/tags.ts";

let outdir: string;
let config: string;

before(() => {
  process.env.PROJEN_DISABLE_POST = "1"; // no install/barrels during synth
  outdir = mkdtempSync(join(tmpdir(), "vite-config-"));

  const root = new DBXToolsNodeProject({
    name: "vite-fixture",
    scope: "fixture",
    outdir,
    defaultTagMixins: false,
  });
  // Tagged explicitly: path-derived tagging reads a `src/` folder off disk, which
  // a synthetic fixture has none of.
  new DBXToolsTypeScriptProject({
    parent: root,
    outdir: "packages/app/web",
    name: "@fixture/web",
    tags: ["app"],
  }).with(PACKAGE_TAG_MIXINS.app);
  root.synth();

  config = readFileSync(join(outdir, "packages/app/web/vite.config.ts"), "utf8");
});

after(() => rmSync(outdir, { recursive: true, force: true }));

describe("generated vite config", () => {
  it("accepts a TypeScript override, not only JavaScript", () => {
    assert.match(config, /"vite\.config\.override\.ts"/);
  });

  it("orders the chain so TypeScript wins over a leftover JavaScript twin", () => {
    // Merge order is the file order: later entries win via `mergeConfig`.
    assert.ok(
      config.indexOf('"vite.config.override.js"') < config.indexOf('"vite.config.override.ts"'),
      "the .ts override must be listed after the .js one",
    );
  });

  it("imports the override through a URL Vite cannot inline, so Node runs it", () => {
    // A static specifier would be bundled by Vite's config loader, which has no
    // TypeScript-from-disk path; a computed URL is left for Node's ESM loader.
    assert.match(config, /new URL\(file, import\.meta\.url\)/);
    assert.match(config, /await import\(overrideUrl\.href\)/);
  });

  it("skips absent overrides rather than failing config load", () => {
    assert.match(config, /existsSync\(overrideUrl\)/);
  });
});
