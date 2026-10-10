import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  chmodSync,
  statSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

import {
  workspaceGraph,
  type WorkspaceGraph,
  type WorkspaceGraphPackage,
} from "../tasks/test-workspace.ts";

const engineRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(engineRoot, "..");
const bun = process.execPath;

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(bun, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeBootstrapManifest(directory: string, archives: Record<string, string>): void {
  const dependencies = Object.fromEntries(
    Object.entries(archives).map(([name, archive]) => [name, `file:${archive}`]),
  );
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "external-consumer",
        private: true,
        type: "module",
        devDependencies: dependencies,
        overrides: Object.fromEntries(
          Object.entries(dependencies).filter(([name]) => name !== "@dbx-tools/projen"),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

function pack(directory: string, archiveDir: string, env: NodeJS.ProcessEnv): string {
  const existing = new Set(readdirSync(archiveDir));
  const manifest = join(directory, "package.json");
  const content = readFileSync(manifest);
  const mode = statSync(manifest).mode;
  chmodSync(manifest, 0o644);
  try {
    run(directory, ["pm", "pack", "--ignore-scripts", "--destination", archiveDir], env);
  } finally {
    writeFileSync(manifest, content);
    chmodSync(manifest, mode);
  }
  const created = readdirSync(archiveDir).filter(
    (file) => file.endsWith(".tgz") && !existing.has(file),
  );
  assert.equal(created.length, 1, `expected one archive from ${directory}`);
  return join(archiveDir, created[0]!);
}

function dependencyClosure(graph: WorkspaceGraph, root: string): WorkspaceGraphPackage[] {
  const packages = new Map(graph.packages.map((pkg) => [pkg.name, pkg]));
  const resolved: WorkspaceGraphPackage[] = [];
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    const pkg = packages.get(name);
    assert.ok(pkg, `workspace graph omitted ${name}`);
    visited.add(name);
    for (const dependency of pkg.dependencies) visit(dependency);
    resolved.push(pkg);
  };
  visit(root);
  return resolved;
}

it("runs a packed engine through an isolated consumer lifecycle", { timeout: 120_000 }, () => {
  const temp = mkdtempSync(join(tmpdir(), "dbx-tools-packed-consumer-"));
  const archiveDir = join(temp, "archive");
  const consumer = join(temp, "consumer");
  const unrelatedCwd = join(temp, "unrelated");
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(join(consumer, "modules/example/src"), { recursive: true });
  mkdirSync(join(consumer, "fixtures"), { recursive: true });
  mkdirSync(unrelatedCwd, { recursive: true });
  const environment = { ...process.env };
  delete environment.PROJEN_DISABLE_POST;

  try {
    const archives = Object.fromEntries(
      dependencyClosure(workspaceGraph(workspaceRoot), "@dbx-tools/projen").map((pkg) => [
        pkg.name,
        pack(resolve(workspaceRoot, pkg.path), archiveDir, environment),
      ]),
    );
    const dependencySpecs = Object.entries(archives).map(
      ([name, archive]) => `${name}@file:${archive}`,
    );
    const dependencyOverrides = Object.entries(archives)
      .filter(([name]) => name !== "@dbx-tools/projen")
      .map(
        ([name, archive]) =>
          `rootProject.package.file.addOverride(${JSON.stringify(`overrides.${name}`)}, ${JSON.stringify(`file:${archive}`)});`,
      );
    writeBootstrapManifest(consumer, archives);
    writeFileSync(
      join(consumer, ".projenrc.ts"),
      [
        'import { project } from "@dbx-tools/projen";',
        'import { Project } from "projen";',
        "const rootProject = new project.DBXToolsNodeProject({",
        '  name: "external-consumer",',
        `  outdir: ${JSON.stringify(consumer)},`,
        '  scope: "external",',
        '  packageRoots: ["modules"],',
        "  defaultTagMixins: false,",
        '  releaseMode: "disabled",',
        "});",
        `rootProject.addDevDeps(${dependencySpecs.map((spec) => JSON.stringify(spec)).join(", ")});`,
        ...dependencyOverrides,
        'project.applyToProjects(rootProject, { path: "modules/example" }, (pkg) => {',
        '  pkg.addDeps("zod@^4.1.5");',
        '  pkg.dbxToolsConfig.codegenInputs.push("fixtures/model.ts=model");',
        "});",
        'if (!(rootProject instanceof Project)) throw new Error("consumer and engine resolved different Projen runtimes");',
        "rootProject.synth();",
        "",
      ].join("\n"),
    );
    writeFileSync(join(consumer, "modules/example/src/example.ts"), "export const value = 1;\n");
    writeFileSync(
      join(consumer, "fixtures/model.ts"),
      "export interface ExternalModel { value: string }\n",
    );

    run(consumer, ["install", "--force"], environment);
    assert.equal(existsSync(join(consumer, "node_modules/@dbx-tools/projen/shims")), false);
    for (const task of [
      "dev-watch.ts",
      "python-node-bindings-watch.ts",
      "python-node-runtime-watch.ts",
    ]) {
      assert.equal(
        existsSync(join(consumer, "node_modules/@dbx-tools/projen/tasks", task)),
        true,
        `packed engine omitted ${task}`,
      );
    }
    run(unrelatedCwd, [join(consumer, ".projenrc.ts")], environment);
    const firstManifest = readFileSync(join(consumer, "modules/example/package.json"), "utf8");
    assert.match(firstManifest, /"codegenInputs"/);
    const firstBarrel = readFileSync(join(consumer, "modules/example/index.ts"), "utf8");
    assert.equal(existsSync(join(consumer, "modules/example/src/model.ts")), true);
    run(unrelatedCwd, [join(consumer, ".projenrc.ts")], environment);
    assert.equal(
      readFileSync(join(consumer, "modules/example/package.json"), "utf8"),
      firstManifest,
    );
    assert.equal(readFileSync(join(consumer, "modules/example/index.ts"), "utf8"), firstBarrel);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
