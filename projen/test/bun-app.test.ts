/** Regression coverage for the generated Bun browser-app scaffold. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DBXToolsNodeProject, DBXToolsTypeScriptProject } from "../src/project.ts";
import { PACKAGE_TAG_MIXINS } from "../src/tags.ts";

let outdir: string;
let bunfig: string;
let dev: string;
let build: string;

before(() => {
  process.env.PROJEN_DISABLE_POST = "1";
  outdir = mkdtempSync(join(tmpdir(), "bun-app-"));

  const root = new DBXToolsNodeProject({
    name: "bun-app-fixture",
    scope: "fixture",
    outdir,
    defaultTagMixins: false,
  });
  new DBXToolsTypeScriptProject({
    parent: root,
    outdir: "packages/app/web",
    name: "@fixture/web",
    tags: ["app"],
  }).with(PACKAGE_TAG_MIXINS.app);
  root.synth();

  const packageDir = join(outdir, "packages/app/web");
  bunfig = readFileSync(join(packageDir, "bunfig.toml"), "utf8");
  dev = readFileSync(join(packageDir, "dev.ts"), "utf8");
  build = readFileSync(join(packageDir, "build.ts"), "utf8");
});

after(() => rmSync(outdir, { recursive: true, force: true }));

describe("generated Bun app", () => {
  it("loads TypeScript overrides only when they exist", () => {
    assert.match(dev, /bun-dev\.override\.ts/);
    assert.match(build, /bun-build\.override\.ts/);
    for (const source of [dev, build]) {
      assert.match(source, /existsSync\(overrideUrl\)/);
      assert.match(source, /await import\(overrideUrl\.href\)/);
    }
  });

  it("uses the Tailwind plugin in development and production", () => {
    assert.match(bunfig, /plugins = \["bun-plugin-tailwind"\]/);
    assert.match(build, /import tailwind from "bun-plugin-tailwind"/);
    assert.match(build, /plugins: \[tailwind\]/);
  });

  it("uses Databricks-safe production defaults", () => {
    assert.match(build, /"process\.env\.NODE_ENV": JSON\.stringify\("production"\)/);
    assert.match(build, /splitting: true/);
    assert.match(build, /publicPath: "\/"/);
    assert.match(build, /external: \["\/fonts\/\*"\]/);
    assert.match(build, /sourcemap: "none"/);
  });

  it("cleans the output and stages public assets", () => {
    assert.match(build, /await rm\(outdir, \{ recursive: true, force: true \}\)/);
    assert.match(build, /if \(existsSync\(publicDir\)\)/);
    assert.match(build, /await cp\(publicDir, outdir, \{ recursive: true \}\)/);
  });

  it("fails a production build when Bun reports errors", () => {
    assert.match(build, /if \(!result\.success\)/);
    assert.match(build, /process\.exit\(1\)/);
  });
});

describe("Bun app eslint ignores", () => {
  it("ignores generated root scripts and unmanaged overrides", () => {
    const raw = readFileSync(join(outdir, ".eslintrc.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const patterns = JSON.parse(raw).ignorePatterns as string[];
    for (const pattern of [
      "**/dev.ts",
      "**/build.ts",
      "**/bunfig.override.toml",
      "**/bun-dev.override.ts",
      "**/bun-build.override.ts",
    ]) {
      assert.ok(patterns.includes(pattern), `missing eslint ignore: ${pattern}`);
    }
  });
});
