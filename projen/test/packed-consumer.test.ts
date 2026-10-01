import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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

function writeBootstrapManifest(directory: string, archive: string): void {
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "external-consumer",
        private: true,
        type: "module",
        devDependencies: {
          "@dbx-tools/projen": `file:${archive}`,
        },
      },
      null,
      2,
    )}\n`,
  );
}

it("runs a packed engine through an isolated consumer lifecycle", { timeout: 120_000 }, () => {
  const temp = mkdtempSync(join(tmpdir(), "dbx-tools-packed-consumer-"));
  const archiveDir = join(temp, "archive");
  const consumer = join(temp, "consumer");
  const unrelatedCwd = join(temp, "unrelated");
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(join(consumer, "modules/example/src"), { recursive: true });
  mkdirSync(join(consumer, "native/example/src"), { recursive: true });
  mkdirSync(join(consumer, "fixtures"), { recursive: true });
  mkdirSync(unrelatedCwd, { recursive: true });
  const environment = { ...process.env };
  delete environment.PROJEN_DISABLE_POST;

  try {
    run(engineRoot, ["pm", "pack", "--ignore-scripts", "--destination", archiveDir], environment);
    const archive = join(
      archiveDir,
      readdirSync(archiveDir).find((file) => file.endsWith(".tgz"))!,
    );
    writeBootstrapManifest(consumer, archive);
    writeFileSync(
      join(consumer, ".projenrc.ts"),
      [
        'import { project as projenProject } from "@dbx-tools/projen";',
        'import { Project } from "projen";',
        "const project = new projenProject.DBXToolsNodeProject({",
        '  name: "external-consumer",',
        `  outdir: ${JSON.stringify(consumer)},`,
        '  scope: "external",',
        '  packageRoots: ["modules"],',
        "  defaultTagMixins: false,",
        '  releaseMode: "disabled",',
        "});",
        'projenProject.applyToProjects(project, { path: "modules/example" }, (pkg) => {',
        '  pkg.addDeps("zod@^4.1.5");',
        '  pkg.package.addField("codegen", { inputs: ["fixtures/model.ts=model"] });',
        "});",
        "const rust = new projenProject.DBXToolsRustWorkspace(project, {",
        '  root: "native",',
        '  scope: "external",',
        '  repository: "https://example.com/external-consumer",',
        "  private: true,",
        "  release: false,",
        '  packages: { example: { description: "External Rust fixture" } },',
        "});",
        'if (!(project instanceof Project)) throw new Error("consumer and engine resolved different Projen runtimes");',
        'if (!(rust.packages[0] instanceof Project)) throw new Error("Rust projects must be native Projen projects");',
        "project.synth();",
        "",
      ].join("\n"),
    );
    writeFileSync(join(consumer, "modules/example/src/example.ts"), "export const value = 1;\n");
    writeFileSync(join(consumer, "native/example/src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
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

    run(unrelatedCwd, [join(consumer, ".projenrc.ts")], environment);
    assert.equal(
      readFileSync(join(consumer, "modules/example/package.json"), "utf8"),
      firstManifest,
    );
    assert.equal(readFileSync(join(consumer, "modules/example/index.ts"), "utf8"), firstBarrel);

    run(consumer, ["run", "compile"], environment);
    run(consumer, ["run", "test"], environment);
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", archiveDir], {
      cwd: join(consumer, "modules/example"),
      env: environment,
      stdio: "ignore",
    });
    assert.equal(existsSync(join(archiveDir, "external-example-0.0.1.tgz")), true);

    const standalone = join(temp, "standalone");
    mkdirSync(join(standalone, "src"), { recursive: true });
    writeBootstrapManifest(standalone, archive);
    writeFileSync(
      join(standalone, ".projenrc.ts"),
      [
        'import { project as projenProject } from "@dbx-tools/projen";',
        "const project = new projenProject.DBXToolsTypeScriptProject({",
        '  name: "standalone-consumer",',
        `  outdir: ${JSON.stringify(standalone)},`,
        '  releaseMode: "disabled",',
        "});",
        "project.synth();",
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
