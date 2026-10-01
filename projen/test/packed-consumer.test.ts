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

const engineRoot = resolve(import.meta.dirname, "..");
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

it("runs a packed engine through an isolated consumer lifecycle", { timeout: 120_000 }, () => {
  const temp = mkdtempSync(join(tmpdir(), "dbx-tools-packed-consumer-"));
  const archiveDir = join(temp, "archive");
  const consumer = join(temp, "consumer");
  const unrelatedCwd = join(temp, "unrelated");
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(join(consumer, "modules/example/src"), { recursive: true });
  mkdirSync(join(consumer, "native/example/src"), { recursive: true });
  mkdirSync(join(consumer, "standalone-rust/src"), { recursive: true });
  mkdirSync(join(consumer, "fixtures"), { recursive: true });
  mkdirSync(unrelatedCwd, { recursive: true });
  const environment = { ...process.env };
  delete environment.PROJEN_DISABLE_POST;

  try {
    const archives = {
      "@dbx-tools/core-rs": pack(
        resolve(engineRoot, "../packages/js/node/core-rs"),
        archiveDir,
        environment,
      ),
      "@dbx-tools/core": pack(
        resolve(engineRoot, "../packages/js/node/core"),
        archiveDir,
        environment,
      ),
      "@dbx-tools/path": pack(
        resolve(engineRoot, "../packages/js/node/path"),
        archiveDir,
        environment,
      ),
      "@dbx-tools/shared-core": pack(
        resolve(engineRoot, "../packages/js/shared/core"),
        archiveDir,
        environment,
      ),
      "@dbx-tools/projen": pack(engineRoot, archiveDir, environment),
    };
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
        '  pkg.package.addField("codegen", { inputs: ["fixtures/model.ts=model"] });',
        "});",
        "const rust = new project.DBXToolsRustWorkspace(rootProject, {",
        '  root: "native",',
        '  scope: "external",',
        '  repository: "https://example.com/external-consumer",',
        "  private: true,",
        "  release: false,",
        '  packages: { example: { description: "External Rust fixture" } },',
        "});",
        "const standaloneRust = new project.DBXToolsRustProject({",
        '  name: "external-standalone",',
        `  outdir: ${JSON.stringify(join(consumer, "standalone-rust"))},`,
        '  version: "1.2.3",',
        '  description: "Standalone external Rust fixture",',
        '  license: "MIT",',
        '  copyrightOwner: "External Consumer",',
        "});",
        'if (!(rootProject instanceof Project)) throw new Error("consumer and engine resolved different Projen runtimes");',
        'if (!(rust.packages[0] instanceof Project)) throw new Error("Rust projects must be native Projen projects");',
        "rootProject.synth();",
        "standaloneRust.synth();",
        "",
      ].join("\n"),
    );
    writeFileSync(join(consumer, "modules/example/src/example.ts"), "export const value = 1;\n");
    writeFileSync(join(consumer, "native/example/src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(join(consumer, "standalone-rust/src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(
      join(consumer, "fixtures/model.ts"),
      "export interface ExternalModel { value: string }\n",
    );

    run(consumer, ["install", "--force"], environment);
    run(unrelatedCwd, [join(consumer, ".projenrc.ts")], environment);
    const firstManifest = readFileSync(join(consumer, "modules/example/package.json"), "utf8");
    assert.match(firstManifest, /"codegen"/);
    const firstBarrel = readFileSync(join(consumer, "modules/example/index.ts"), "utf8");
    assert.equal(existsSync(join(consumer, "modules/example/src/model.ts")), true);
    assert.match(
      readFileSync(join(consumer, "native/example/Cargo.toml"), "utf8"),
      /name = "external-example"[\s\S]*publish = false/,
    );
    assert.match(
      readFileSync(join(consumer, "standalone-rust/Cargo.toml"), "utf8"),
      /name = "external-standalone"[\s\S]*version = "1\.2\.3"[\s\S]*edition = "2021"/,
    );

    run(unrelatedCwd, [join(consumer, ".projenrc.ts")], environment);
    assert.equal(
      readFileSync(join(consumer, "modules/example/package.json"), "utf8"),
      firstManifest,
    );
    assert.equal(readFileSync(join(consumer, "modules/example/index.ts"), "utf8"), firstBarrel);

    run(consumer, ["run", "compile"], environment);
    run(consumer, ["run", "test"], environment);
    run(join(consumer, "standalone-rust"), ["x", "projen", "compile"], environment);
    run(join(consumer, "standalone-rust"), ["x", "projen", "test"], environment);
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", archiveDir], {
      cwd: join(consumer, "modules/example"),
      env: environment,
      stdio: "ignore",
    });
    assert.equal(existsSync(join(archiveDir, "external-example-0.0.1.tgz")), true);

    const standalone = join(temp, "standalone");
    mkdirSync(join(standalone, "src"), { recursive: true });
    writeBootstrapManifest(standalone, archives);
    writeFileSync(
      join(standalone, ".projenrc.ts"),
      [
        'import { project } from "@dbx-tools/projen";',
        "const rootProject = new project.DBXToolsTypeScriptProject({",
        '  name: "standalone-consumer",',
        `  outdir: ${JSON.stringify(standalone)},`,
        '  releaseMode: "disabled",',
        "});",
        `rootProject.addDevDeps(${dependencySpecs.map((spec) => JSON.stringify(spec)).join(", ")});`,
        ...dependencyOverrides,
        "rootProject.synth();",
        "",
      ].join("\n"),
    );
    writeFileSync(join(standalone, "src/main.ts"), "export const value = 1;\n");
    run(standalone, ["install", "--force"], environment);
    run(unrelatedCwd, [join(standalone, ".projenrc.ts")], environment);
    assert.equal(existsSync(join(standalone, "index.ts")), true);
    run(standalone, ["run", "compile"], environment);
    run(standalone, ["run", "test"], environment);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
