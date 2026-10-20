import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { header } from "../src/generated.ts";
import { DBXToolsNodeProject } from "../src/project-js.ts";

const fixtures: string[] = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "appkit-workspace-"));
  fixtures.push(root);
  for (const directory of [
    "packages/app/demo/src",
    "packages/server/demo/src",
    "packages/ui/library/src",
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, "main.ts"), "export const value = true;\n");
  }
  writeFileSync(join(root, "packages/app/demo/index.html"), '<div id="root"></div>\n');
  writeFileSync(join(root, "packages/app/demo/vite.config.ts"), "export default {};\n");
  writeFileSync(join(root, "packages/server/demo/src/server.ts"), "export const server = true;\n");
  return root;
}

function manifest(root: string, directory: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

it("auto-configures AppKit app and server packages without broadening UI libraries", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const root = fixture();
  new DBXToolsNodeProject({
    name: "fixture",
    outdir: root,
    packageDefaults: { publishable: false },
    packageRoots: ["packages"],
    releaseMode: "disabled",
  }).synth();

  const app = manifest(root, "packages/app/demo");
  const server = manifest(root, "packages/server/demo");
  const ui = manifest(root, "packages/ui/library");
  const appDependencies = app.dependencies as Record<string, string>;
  const appDevDependencies = app.devDependencies as Record<string, string>;
  const serverDependencies = server.dependencies as Record<string, string>;
  const uiDependencies = (ui.dependencies ?? {}) as Record<string, string>;

  assert.deepEqual(app.appkit, { autoMigrate: false });
  assert.equal(app.private, true);
  assert.equal(server.private, true);
  assert.equal(ui.private, true);
  assert.equal(appDependencies["@databricks/appkit-ui"], "catalog:");
  assert.equal(appDependencies["@tailwindcss/vite"], "catalog:");
  assert.equal(appDependencies.tailwindcss, "catalog:");
  assert.equal(appDevDependencies["@databricks/appkit"], "catalog:");
  assert.equal(appDevDependencies.vite, "catalog:");
  assert.equal(serverDependencies["@databricks/appkit"], "catalog:");
  assert.equal(serverDependencies["@vitejs/plugin-react"], "catalog:");
  assert.equal(server.main, "src/server.ts");
  assert.equal(server.types, "src/server.ts");
  assert.equal(uiDependencies["@databricks/appkit-ui"], undefined);
  assert.equal(uiDependencies.tailwindcss, undefined);

  const appTsconfig = readFileSync(join(root, "packages/app/demo/tsconfig.json"), "utf8");
  assert.match(appTsconfig, /"rootDir": "\."/);
  assert.match(appTsconfig, /"vite\.config\.ts"/);
  assert.match(appTsconfig, /"shared\/appkit-types"/);

  const tasks = JSON.parse(readFileSync(join(root, ".projen/tasks.json"), "utf8")) as {
    tasks: Record<
      string,
      { steps?: Array<{ exec?: string; execArgs?: string[]; spawn?: string }> }
    >;
  };
  assert.equal(tasks.tasks["appkit:sync"]?.steps?.[0]?.exec, "appkit plugin sync --write --silent");
  assert.deepEqual(tasks.tasks["appkit:deploy"]?.steps?.[0]?.execArgs, [
    "bun",
    "node_modules/@dbx-tools/projen/tasks/appkit-deploy.ts",
  ]);
  assert.deepEqual(
    tasks.tasks.deploy?.steps?.map((step) => step.spawn),
    ["check", "appkit:deploy"],
  );
  assert.equal(tasks.tasks.check?.steps?.[0]?.spawn, "build");
  assert.equal(tasks.tasks.dev?.steps?.[0]?.exec, "bun --watch packages/server/demo/src/server.ts");
  assert.equal(tasks.tasks.start?.steps?.[0]?.exec, "bun packages/server/demo/src/server.ts");
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\.databricks$/m);
});

it("does not configure AppKit packages when disabled", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const root = fixture();
  new DBXToolsNodeProject({
    appkit: false,
    name: "fixture",
    outdir: root,
    packageRoots: ["packages"],
    releaseMode: "disabled",
  }).synth();

  const app = manifest(root, "packages/app/demo");
  const server = manifest(root, "packages/server/demo");
  assert.equal(app.appkit, undefined);
  assert.equal((app.dependencies as Record<string, string>)["@databricks/appkit-ui"], undefined);
  assert.equal((server.dependencies as Record<string, string>)["@databricks/appkit"], undefined);
});

it("fails immediately when explicit AppKit mode lacks a required package role", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const root = mkdtempSync(join(tmpdir(), "appkit-workspace-"));
  fixtures.push(root);
  mkdirSync(join(root, "packages/app/demo/src"), { recursive: true });
  writeFileSync(join(root, "packages/app/demo/src/main.ts"), "export const value = true;\n");

  assert.throws(
    () =>
      new DBXToolsNodeProject({
        appkit: true,
        name: "fixture",
        outdir: root,
        packageRoots: ["packages"],
        releaseMode: "disabled",
      }),
    /appkit: true requires a `server` package/,
  );
});

it("fails immediately when explicit AppKit mode lacks a required entry file", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const root = fixture();
  unlinkSync(join(root, "packages/app/demo/index.html"));

  assert.throws(
    () =>
      new DBXToolsNodeProject({
        appkit: true,
        name: "fixture",
        outdir: root,
        packageRoots: ["packages"],
        releaseMode: "disabled",
      }),
    /@fixture\/app-demo\/index\.html/,
  );
});

it("generates a monorepo-safe Vite config when the app does not provide one", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const root = fixture();
  unlinkSync(join(root, "packages/app/demo/vite.config.ts"));
  const options = {
    appkit: true,
    name: "fixture",
    outdir: root,
    packageRoots: ["packages"],
    releaseMode: "disabled" as const,
  };
  new DBXToolsNodeProject(options).synth();
  new DBXToolsNodeProject(options).synth();

  const viteConfig = readFileSync(join(root, "packages/app/demo/vite.config.ts"), "utf8");
  assert.ok(viteConfig.startsWith(header({ tool: "projen", source: ".projenrc.ts" })));
  assert.match(viteConfig, /appKitServingTypesPlugin/);
  assert.match(viteConfig, /appKitTypesPlugin/);
  assert.match(viteConfig, /demo\/shared\/appkit-types/);
  assert.match(viteConfig, /vite\.config\.override\.ts/);
  assert.equal(statSync(join(root, "packages/app/demo/vite.config.ts")).mode & 0o777, 0o444);
});

it("accepts complete explicit AppKit package roles", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const root = fixture();
  new DBXToolsNodeProject({
    appkit: true,
    name: "fixture",
    outdir: root,
    packageRoots: ["packages"],
    releaseMode: "disabled",
  }).synth();

  assert.deepEqual(manifest(root, "packages/app/demo").appkit, { autoMigrate: false });
});

it("preserves a repository-owned deploy task", () => {
  process.env.PROJEN_DISABLE_POST = "1";
  const root = fixture();
  const project = new DBXToolsNodeProject({
    name: "fixture",
    outdir: root,
    packageRoots: ["packages"],
    releaseMode: "disabled",
  });
  project.addTask("check", { exec: "bun scripts/check.ts" });
  project.addTask("deploy", { exec: "bun scripts/deploy.ts" });
  project.synth();

  const tasks = JSON.parse(readFileSync(join(root, ".projen/tasks.json"), "utf8")) as {
    tasks: Record<string, { steps?: Array<{ exec?: string }> }>;
  };
  assert.equal(tasks.tasks.check?.steps?.[0]?.exec, "bun scripts/check.ts");
  assert.equal(tasks.tasks.deploy?.steps?.[0]?.exec, "bun scripts/deploy.ts");
});
