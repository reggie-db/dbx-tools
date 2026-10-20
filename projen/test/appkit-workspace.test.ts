import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";

import { BUN_VERSION } from "../src/bun-workflow.ts";
import { DBXToolsNodeProject } from "../src/project-js.ts";

const fixtures: string[] = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(appRoot = "packages/app"): string {
  const root = mkdtempSync(join(tmpdir(), "appkit-workspace-"));
  fixtures.push(root);
  mkdirSync(join(root, appRoot, "client"), { recursive: true });
  mkdirSync(join(root, appRoot, "server"), { recursive: true });
  writeFileSync(join(root, appRoot, "client/index.html"), '<div id="root"></div>\n');
  writeFileSync(join(root, appRoot, "server/server.ts"), "export const server = true;\n");
  return root;
}

function manifest(root: string, appRoot = "packages/app"): Record<string, any> {
  return JSON.parse(readFileSync(join(root, appRoot, "package.json"), "utf8"));
}

it("auto-configures one application project at packages/app", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const root = fixture();
  new DBXToolsNodeProject({
    name: "fixture",
    outdir: root,
    packageRoots: ["packages"],
    releaseMode: "disabled",
  }).synth();

  const app = manifest(root);
  assert.equal(app.private, true);
  assert.equal(app.main, "server/server.ts");
  assert.equal(app.scripts.build, "bun build.ts");
  assert.deepEqual(app.appkit, { autoMigrate: false });
  assert.equal(app.dependencies["@databricks/appkit"], "catalog:");
  assert.equal(app.dependencies["@databricks/appkit-ui"], "catalog:");
  assert.equal(app.dependencies.bun, BUN_VERSION);
  assert.deepEqual(app.exports, { "./package.json": "./package.json" });
  assert.equal(existsSync(join(root, "packages/app/client/package.json")), false);
  assert.equal(existsSync(join(root, "packages/app/server/package.json")), false);

  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /packages\/app/);
  assert.doesNotMatch(workspace, /packages\/app\/client|packages\/app\/server/);

  const tasks = JSON.parse(readFileSync(join(root, ".projen/tasks.json"), "utf8")) as {
    tasks: Record<string, { cwd?: string; steps?: Array<{ exec?: string; execArgs?: string[] }> }>;
  };
  assert.equal(tasks.tasks["appkit:sync"]?.cwd, "packages/app");
  assert.equal(tasks.tasks["appkit:typegen"]?.cwd, "packages/app");
  assert.deepEqual(tasks.tasks["appkit:deploy"]?.steps?.[0]?.execArgs, [
    "bun",
    "node_modules/@dbx-tools/projen/tasks/appkit-deploy.ts",
    "--directory",
    "packages/app",
  ]);
  assert.equal(tasks.tasks.dev?.cwd, "packages/app");
  assert.equal(tasks.tasks.dev?.steps?.[0]?.exec, "bun --watch server/server.ts");
});

it("supports an overridden application root and application-owned bundle", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const root = fixture("packages/demo");
  writeFileSync(join(root, "packages/demo/databricks.yml"), "bundle:\n  name: custom\n");
  new DBXToolsNodeProject({
    appBundle: false,
    appRoot: "packages/demo",
    name: "fixture",
    outdir: root,
    packageRoots: ["packages"],
    releaseMode: "disabled",
    resolvePackageOptions: (pkg, defaults) =>
      pkg.memberPath === "packages/demo" ? { ...defaults, name: "@fixture/demo" } : defaults,
  }).synth();

  assert.equal(manifest(root, "packages/demo").name, "@fixture/demo");
  assert.equal(
    readFileSync(join(root, "packages/demo/databricks.yml"), "utf8"),
    "bundle:\n  name: custom\n",
  );
  assert.equal(existsSync(join(root, "packages/demo/client/package.json")), false);
});

it("generates only the minimal AppKit and Bun configuration", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const root = fixture();
  new DBXToolsNodeProject({
    appkit: true,
    name: "fixture",
    outdir: root,
    packageRoots: ["packages"],
    releaseMode: "disabled",
  }).synth();

  for (const file of [
    "app.yaml",
    "build.ts",
    "bunfig.toml",
    "client/vite.config.ts",
    "databricks.yml",
    "tsconfig.json",
    "tsconfig.client.json",
    "tsconfig.server.json",
    "tsconfig.shared.json",
  ]) {
    const path = join(root, "packages/app", file);
    assert.equal(existsSync(path), true, file);
    assert.equal(statSync(path).mode & 0o777, 0o444, file);
  }
  for (const file of [
    "CLAUDE.md",
    ".npmrc",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "eslint.config.js",
    ".prettierrc.json",
    "postcss.config.js",
    "tailwind.config.ts",
    "tsdown.server.config.ts",
    "vitest.config.ts",
  ]) {
    assert.equal(existsSync(join(root, "packages/app", file)), false, file);
  }

  const appYaml = readFileSync(join(root, "packages/app/app.yaml"), "utf8");
  assert.match(appYaml, /\.\/node_modules\/\.bin\/bun/);
  assert.match(appYaml, /server\/server\.ts/);
  assert.doesNotMatch(appYaml, /\nenv:/);

  const build = readFileSync(join(root, "packages/app/build.ts"), "utf8");
  assert.match(build, /name: "source-alias"/);
  assert.match(build, /plugins: \[tailwind, dedupeReact, sourceAlias\]/);
  assert.match(build, /tsconfig: "tsconfig\.client\.json"/);

  const bundle = readFileSync(join(root, "packages/app/databricks.yml"), "utf8");
  assert.match(bundle, /engine: direct/);
  assert.match(bundle, /source_code_path: \.\//);
});

it("does not configure AppKit files when disabled", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const root = fixture();
  new DBXToolsNodeProject({
    appkit: false,
    name: "fixture",
    outdir: root,
    packageRoots: ["packages"],
    releaseMode: "disabled",
  }).synth();

  assert.equal(manifest(root).appkit, undefined);
  assert.equal(existsSync(join(root, "packages/app/app.yaml")), false);
});

it("leaves an incomplete application root unconfigured in automatic mode", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const root = fixture();
  rmSync(join(root, "packages/app/server/server.ts"));
  new DBXToolsNodeProject({
    name: "fixture",
    outdir: root,
    packageRoots: ["packages"],
    releaseMode: "disabled",
  }).synth();

  assert.equal(manifest(root).appkit, undefined);
  assert.equal(existsSync(join(root, "packages/app/app.yaml")), false);
});

it("fails explicit AppKit mode without an application root", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const root = mkdtempSync(join(tmpdir(), "appkit-workspace-"));
  fixtures.push(root);
  assert.throws(
    () =>
      new DBXToolsNodeProject({
        appkit: true,
        name: "fixture",
        outdir: root,
        packageRoots: ["packages"],
        releaseMode: "disabled",
      }),
    /requires an application root/,
  );
});

it("fails explicit AppKit mode when client or server entries are missing", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const root = fixture();
  rmSync(join(root, "packages/app/client/index.html"));
  assert.throws(
    () =>
      new DBXToolsNodeProject({
        appkit: true,
        name: "fixture",
        outdir: root,
        packageRoots: ["packages"],
        releaseMode: "disabled",
      }),
    /client\/index\.html/,
  );
});

it("keeps a second synthesis stable", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const root = fixture();
  const options = {
    appkit: true,
    name: "fixture",
    outdir: root,
    packageRoots: ["packages"],
    releaseMode: "disabled" as const,
  };
  new DBXToolsNodeProject(options).synth();
  const first = readFileSync(join(root, "packages/app/client/vite.config.ts"), "utf8");
  new DBXToolsNodeProject(options).synth();
  assert.equal(readFileSync(join(root, "packages/app/client/vite.config.ts"), "utf8"), first);
});
