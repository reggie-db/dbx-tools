import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parse } from "smol-toml";
import {
  readWorkflow,
  workflowStep,
  type WorkflowDefinition,
  type WorkflowJob,
} from "./workflow.ts";
import type { RustReleaseConfiguration } from "../src/_rust-release-workflow.ts";
import { synchronizeCargoLockVersions } from "../src/project-rs.ts";
import {
  DBXToolsNodeProject,
  DBXToolsPythonWorkspace,
  DBXToolsRustProject,
  DBXToolsRustWorkspace,
  RustReleaseCpu,
  RustReleaseOs,
} from "../src/project.ts";

let outdir: string;

before(() => {
  process.env.PROJEN_DISABLE_POST = "1";
  outdir = mkdtempSync(join(tmpdir(), "project-rs-"));
  mkdirSync(join(outdir, "packages/rs/databricks-auth/src"), { recursive: true });
  writeFileSync(
    join(outdir, "packages/rs/databricks-auth/src/lib.rs"),
    "pub fn value() {}\nuniffi::setup_scaffolding!();\n",
  );
  mkdirSync(join(outdir, "packages/rs/tool/src"), { recursive: true });
  writeFileSync(join(outdir, "packages/rs/tool/src/main.rs"), "fn main() {}\n");
});

after(() => rmSync(outdir, { recursive: true, force: true }));

function readRustReleaseConfiguration(directory: string): RustReleaseConfiguration {
  return JSON.parse(
    readFileSync(join(directory, ".projen/rust-release.json"), "utf8"),
  ) as RustReleaseConfiguration;
}

function bindingReleaseConfiguration(binding: "node" | "python"): RustReleaseConfiguration {
  const bindingOutdir = mkdtempSync(join(tmpdir(), `project-rs-${binding}-`));
  try {
    mkdirSync(join(bindingOutdir, "native/addon/src"), { recursive: true });
    writeFileSync(
      join(bindingOutdir, "native/addon/src/lib.rs"),
      "uniffi::setup_scaffolding!();\n",
    );
    const project = new DBXToolsNodeProject({
      name: `@fixture/${binding}-root`,
      scope: "fixture",
      outdir: bindingOutdir,
      packageRoots: ["packages/js"],
      defaultTagMixins: false,
      github: true,
      nodeRelease: false,
    });
    new DBXToolsRustWorkspace(project, {
      root: "native",
      releasePlatforms: [{ os: RustReleaseOs.LINUX, cpu: RustReleaseCpu.X64 }],
      packages: { addon: { bindings: [binding] } },
    });
    project.synth();
    return readRustReleaseConfiguration(bindingOutdir);
  } finally {
    rmSync(bindingOutdir, { recursive: true, force: true });
  }
}

function stepNames(job: WorkflowJob): string[] {
  return job.steps.flatMap((step) => (step.name ? [step.name] : []));
}

it("updates workspace lock versions without changing registry packages", () => {
  const lock = [
    "version = 4",
    "",
    "[[package]]",
    'name = "fixture-core"',
    'version = "0.1.0"',
    "",
    "[[package]]",
    'name = "external"',
    'version = "2.0.0"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    'checksum = "abc"',
    "",
  ].join("\n");
  assert.equal(
    synchronizeCargoLockVersions(lock, new Set(["fixture-core"]), "1.2.3"),
    lock.replace('version = "0.1.0"', 'version = "1.2.3"'),
  );
});

describe("DBXToolsRustProject", () => {
  it("synthesizes a standalone Cargo project with concrete metadata and native tasks", () => {
    const directory = mkdtempSync(join(tmpdir(), "project-rs-standalone-"));
    try {
      mkdirSync(join(directory, "src"), { recursive: true });
      writeFileSync(join(directory, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
      writeFileSync(join(directory, "src/main.rs"), "fn main() {}\n");
      const project = new DBXToolsRustProject({
        name: "external-native",
        outdir: directory,
        version: "1.2.3",
        edition: "2024",
        rustVersion: "1.85",
        license: "MIT",
        copyrightOwner: "Example",
        repository: "https://github.com/example/external-native",
        description: "Standalone Rust fixture",
        binaryName: "external",
        defaultRun: "external",
        features: { native: [] },
        defaultFeatures: ["native"],
        examples: [
          {
            name: "generated-contracts",
            path: "examples/generated-contracts.rs",
            requiredFeatures: ["native"],
          },
        ],
        dependencies: { serde: "1" },
        targetDependencies: {
          'cfg(target_os = "linux")': { libc: "0.2" },
        },
      });
      project.synth();

      const manifest = parse(readFileSync(join(directory, "Cargo.toml"), "utf8")) as {
        package: Record<string, unknown>;
        lib: Record<string, unknown>;
        bin: Array<Record<string, unknown>>;
        example: Array<Record<string, unknown>>;
        features: Record<string, unknown>;
        dependencies: Record<string, unknown>;
        target: Record<string, { dependencies: Record<string, unknown> }>;
      };
      assert.deepEqual(manifest.package, {
        name: "external-native",
        "default-run": "external",
        version: "1.2.3",
        edition: "2024",
        "rust-version": "1.85",
        description: "Standalone Rust fixture",
        license: "MIT",
        repository: "https://github.com/example/external-native",
      });
      assert.equal(manifest.lib.name, "external_native");
      assert.deepEqual(manifest.bin, [{ name: "external", path: "src/main.rs" }]);
      assert.deepEqual(manifest.example, [
        {
          name: "generated-contracts",
          path: "examples/generated-contracts.rs",
          "required-features": ["native"],
        },
      ]);
      assert.deepEqual(manifest.features, { default: ["native"], native: [] });
      assert.equal(manifest.dependencies.serde, "1");
      assert.equal(manifest.target['cfg(target_os = "linux")']?.dependencies.libc, "0.2");
      assert.match(readFileSync(join(directory, "LICENSE"), "utf8"), /Copyright \(c\).*Example/);
      assert.match(readFileSync(join(directory, ".gitignore"), "utf8"), /^target\/$/m);

      const tasks = JSON.parse(readFileSync(join(directory, ".projen/tasks.json"), "utf8")) as {
        tasks: Record<string, { steps: Array<{ exec?: string }> }>;
      };
      assert.equal(tasks.tasks.compile?.steps[0]?.exec, "cargo build");
      assert.equal(tasks.tasks.test?.steps[0]?.exec, "cargo test");
      assert.equal(tasks.tasks.package?.steps[0]?.exec, "cargo package");
      assert.equal(tasks.tasks.lint?.steps[0]?.exec, "cargo clippy --all-targets --all-features");
      assert.equal(tasks.tasks.format?.steps[0]?.exec, "cargo fmt");
      assert.equal(tasks.tasks["format:check"]?.steps[0]?.exec, "cargo fmt -- --check");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("DBXToolsRustWorkspace", () => {
  it("imports shared binding contracts through workspace dependencies", () => {
    const directory = mkdtempSync(join(tmpdir(), "project-rs-shared-"));
    try {
      for (const name of ["auth", "provider"]) {
        mkdirSync(join(directory, `packages/rs/${name}/src`), { recursive: true });
        writeFileSync(
          join(directory, `packages/rs/${name}/src/lib.rs`),
          "uniffi::setup_scaffolding!();\n",
        );
      }
      const project = new DBXToolsNodeProject({
        name: "@fixture/shared",
        scope: "fixture",
        outdir: directory,
        packageRoots: ["packages/js"],
        defaultTagMixins: false,
        github: true,
        nodeRelease: false,
      });
      const rust = new DBXToolsRustWorkspace(project, {
        workspaceDependencies: { shared: { package: "fixture-auth", path: "packages/rs/auth" } },
        packages: { provider: { dependencies: { shared: { workspace: true } } } },
      });
      project.synth();
      assert.deepEqual(
        rust.pythonPackages.find((pkg) => pkg.directory === "provider-rs")?.internalDependencies,
        ["auth-rs"],
      );
      const manifest = JSON.parse(
        readFileSync(join(directory, "packages/js/node/provider-rs/package.json"), "utf8"),
      );
      assert.equal(manifest.dependencies["@fixture/auth-rs"], "workspace:*");
      assert.match(
        readFileSync(join(directory, "packages/rs/provider/uniffi.toml"), "utf8"),
        /fixture_auth = "fixture.auth_rs.bindings"/,
      );
      assert.deepEqual(
        (
          parse(readFileSync(join(directory, "packages/rs/provider/uniffi.toml"), "utf8")) as {
            bindings: { python: { external_packages: Record<string, string> } };
          }
        ).bindings.python.external_packages,
        { fixture_auth: "fixture.auth_rs.bindings" },
      );
      assert.deepEqual(
        rust.bindingMappings.find((binding) => binding.crate === "fixture-provider")?.dependencies,
        ["fixture-auth"],
      );
      const cargoPublish = workflowStep(
        readWorkflow(directory).jobs["publish-cargo"]!,
        "Publish public crates",
      ).run!;
      assert.ok(
        cargoPublish.indexOf('--package "fixture-auth"') <
          cargoPublish.indexOf('--package "fixture-provider"'),
      );
      assert.equal("publish-fixture-provider" in readWorkflow(directory).jobs, false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("omits Rust release workflows when no releasable Rust package exists", () => {
    const emptyOutdir = mkdtempSync(join(tmpdir(), "project-rs-empty-"));
    try {
      const project = new DBXToolsNodeProject({
        name: "@fixture/empty-root",
        scope: "fixture",
        outdir: emptyOutdir,
        packageRoots: ["packages/js"],
        defaultTagMixins: false,
        github: true,
        nodeRelease: false,
      });
      new DBXToolsRustWorkspace(project, {});
      project.synth();
      const jobs = readWorkflow(emptyOutdir).jobs;
      assert.equal("rust-uniffi" in jobs, false);
      assert.equal("rust-binaries" in jobs, false);
      assert.equal(existsSync(join(emptyOutdir, ".github/workflows/rust-cache.yml")), false);
      assert.equal(existsSync(join(emptyOutdir, ".github/workflows/release-dispatch.yml")), false);
    } finally {
      rmSync(emptyOutdir, { recursive: true, force: true });
    }
  });

  it("records code-first Rust OpenAPI producers for the shared generator", () => {
    const openapiOutdir = mkdtempSync(join(tmpdir(), "project-rs-openapi-"));
    try {
      mkdirSync(join(openapiOutdir, "native/api/src"), { recursive: true });
      writeFileSync(join(openapiOutdir, "native/api/src/main.rs"), "fn main() {}\n");
      const project = new DBXToolsNodeProject({
        name: "@fixture/openapi-root",
        scope: "fixture",
        outdir: openapiOutdir,
        packageRoots: ["packages/js"],
        defaultTagMixins: false,
        github: false,
        nodeRelease: false,
      });
      const rust = new DBXToolsRustWorkspace(project, {
        root: "native",
        packages: {
          api: {
            binaryName: "fixture-api",
            features: { docs: [] },
            openapi: {
              binary: "fixture-api",
              features: ["docs"],
              noDefaultFeatures: true,
            },
          },
        },
      });
      project.synth();

      assert.deepEqual(rust.workspaceMapping.openapi, [
        {
          crate: "fixture-api",
          rust: "native/api",
          output: "packages/js/openapi/api",
          binary: "fixture-api",
          features: ["docs"],
          noDefaultFeatures: true,
        },
      ]);
      assert.deepEqual(project.dbxToolsConfig.rust.openapi, rust.workspaceMapping.openapi);
    } finally {
      rmSync(openapiOutdir, { recursive: true, force: true });
    }
  });

  it("builds binary-only releases without Bun, Node, or uv", () => {
    const binaryOutdir = mkdtempSync(join(tmpdir(), "project-rs-binary-"));
    try {
      mkdirSync(join(binaryOutdir, "packages/rs/tool/src"), { recursive: true });
      writeFileSync(join(binaryOutdir, "packages/rs/tool/src/main.rs"), "fn main() {}\n");
      const project = new DBXToolsNodeProject({
        name: "@fixture/binary-root",
        scope: "fixture",
        outdir: binaryOutdir,
        packageRoots: ["packages/js"],
        defaultTagMixins: false,
        github: true,
        nodeRelease: false,
      });
      new DBXToolsRustWorkspace(project, {
        releasePlatforms: [{ os: RustReleaseOs.LINUX, cpu: RustReleaseCpu.X64 }],
        packages: { tool: { release: true } },
      });
      project.synth();

      const release = readWorkflow(binaryOutdir);
      assert.equal(release.jobs["rust-build"], undefined);
      assert.equal(release.jobs["publish-github-release"], undefined);
      const configuration = readRustReleaseConfiguration(binaryOutdir);
      assert.equal(configuration.targets.length, 1);
      assert.deepEqual(configuration.targets[0]?.binaries, ["fixture-tool"]);
      const cargoJob = release.jobs["publish-cargo"]!;
      assert.equal(
        stepNames(cargoJob).some((name) => /Setup Bun|Setup Node\.js|Setup uv/.test(name)),
        false,
      );
      const tasks = JSON.parse(readFileSync(join(binaryOutdir, ".projen/tasks.json"), "utf8")) as {
        tasks: Record<string, { steps?: Array<{ exec?: string }> }>;
      };
      assert.match(tasks.tasks["release:assets"]?.steps?.[0]?.exec ?? "", /release-candidate/);
      assert.equal(existsSync(join(binaryOutdir, ".projen/uniffi-release.mjs")), false);
      assert.equal(existsSync(join(binaryOutdir, ".projen/uniffi-python.js")), false);
      assert.equal(existsSync(join(binaryOutdir, ".projen/smol-toml.cjs")), false);
    } finally {
      rmSync(binaryOutdir, { recursive: true, force: true });
    }
  });

  it("keeps Rust binaries in the approved candidate and promotes Cargo from VERSION", () => {
    const fixedOutdir = mkdtempSync(join(tmpdir(), "project-rs-fixed-release-"));
    try {
      writeFileSync(join(fixedOutdir, "VERSION"), "1.4.0\n");
      mkdirSync(join(fixedOutdir, "packages/rs/tool/src"), { recursive: true });
      writeFileSync(join(fixedOutdir, "packages/rs/tool/src/main.rs"), "fn main() {}\n");
      const project = new DBXToolsNodeProject({
        name: "@fixture/root",
        scope: "fixture",
        outdir: fixedOutdir,
        packageRoots: ["packages/js"],
        defaultTagMixins: false,
        github: true,
        nodeRelease: false,
        repository: "https://github.com/example/fixture.git",
      });
      new DBXToolsRustWorkspace(project, {
        cliRegistryPath: "packages/js/node/rust-binary/src/_registry.ts",
        releasePlatforms: [{ os: RustReleaseOs.LINUX, cpu: RustReleaseCpu.X64 }],
        packages: {
          tool: {
            release: true,
            cli: true,
          },
        },
      });
      project.synth();

      const workflow = readWorkflow(fixedOutdir);
      assert.equal(workflow.jobs["rust-build"], undefined);
      assert.equal(workflow.jobs["publish-github-release"], undefined);
      assert.ok(workflow.jobs["verify-context"]);
      assert.ok(workflow.jobs["publish-cargo"]);
      const registry = readFileSync(
        join(fixedOutdir, "packages/js/node/rust-binary/src/_registry.ts"),
        "utf8",
      );
      assert.match(registry, /"tagPrefix": "v"/);
      assert.match(registry, /"tag": "v1\.4\.0"/);
    } finally {
      rmSync(fixedOutdir, { recursive: true, force: true });
    }
  });

  it("excludes release binaries from incompatible operating systems", () => {
    const platformOutdir = mkdtempSync(join(tmpdir(), "project-rs-platform-"));
    try {
      mkdirSync(join(platformOutdir, "packages/rs/platform-helper/src"), { recursive: true });
      writeFileSync(
        join(platformOutdir, "packages/rs/platform-helper/src/main.rs"),
        "fn main() {}\n",
      );
      mkdirSync(join(platformOutdir, "packages/rs/tool/src"), { recursive: true });
      writeFileSync(join(platformOutdir, "packages/rs/tool/src/main.rs"), "fn main() {}\n");
      const project = new DBXToolsNodeProject({
        name: "@fixture/platform-root",
        scope: "fixture",
        outdir: platformOutdir,
        packageRoots: ["packages/js"],
        defaultTagMixins: false,
        github: true,
        nodeRelease: false,
      });
      new DBXToolsRustWorkspace(project, {
        releasePlatforms: [
          { os: RustReleaseOs.LINUX, cpu: RustReleaseCpu.X64 },
          { os: RustReleaseOs.WINDOWS, cpu: RustReleaseCpu.X64 },
          { os: RustReleaseOs.WINDOWS, cpu: RustReleaseCpu.ARM64 },
        ],
        packages: {
          "platform-helper": {
            private: true,
            release: true,
            releaseExcludeOs: [RustReleaseOs.WINDOWS],
          },
          tool: { release: true },
        },
      });
      project.synth();

      const matrix = readRustReleaseConfiguration(platformOutdir).targets;
      assert.deepEqual(matrix.find((target) => target.os === "linux")?.packages, [
        "fixture-platform-helper",
        "fixture-tool",
      ]);
      assert.deepEqual(
        matrix
          .filter((target) => target.os === "win32")
          .map((target) => [target.cpu, target.packages]),
        [
          ["x64", ["fixture-tool"]],
          ["arm64", ["fixture-tool"]],
        ],
      );
      assert.deepEqual(matrix.find((target) => target.os === "linux")?.binaries, [
        "fixture-platform-helper",
        "fixture-tool",
      ]);
      assert.deepEqual(
        matrix.filter((target) => target.os === "win32").map((target) => target.binaries),
        [["fixture-tool"], ["fixture-tool"]],
      );
    } finally {
      rmSync(platformOutdir, { recursive: true, force: true });
    }
  });

  it("generates CLI release metadata from the selected Rust targets", () => {
    const directory = mkdtempSync(join(tmpdir(), "project-rs-cli-"));
    try {
      mkdirSync(join(directory, "native/tool/src"), { recursive: true });
      writeFileSync(join(directory, "native/tool/src/main.rs"), "fn main() {}\n");
      const project = new DBXToolsNodeProject({
        name: "@fixture/root",
        scope: "fixture",
        outdir: directory,
        packageRoots: ["packages/js"],
        defaultTagMixins: false,
        github: true,
        repository: "https://github.com/example/fixture.git",
      });
      const rust = new DBXToolsRustWorkspace(project, {
        root: "native",
        cliRegistryPath: "packages/js/cli/root/src/_release-binaries.ts",
        releasePlatforms: [
          { os: RustReleaseOs.LINUX, cpu: RustReleaseCpu.X64 },
          { os: RustReleaseOs.WINDOWS, cpu: RustReleaseCpu.X64 },
        ],
        packages: {
          tool: {
            release: true,
            releaseExcludeOs: [RustReleaseOs.WINDOWS],
            binaryName: "fixture-tool",
            description: "Run the fixture tool",
            cli: { command: "tool", hidden: true },
            features: { desktop: [] },
            binaries: [
              {
                name: "fixture-tool-desktop",
                path: "src/desktop.rs",
                requiredFeatures: ["desktop"],
                release: true,
                description: "Run the desktop fixture",
                cli: { command: "tool-desktop", hidden: true },
              },
            ],
          },
        },
      });
      project.synth();

      assert.deepEqual(rust.releaseBinaries, [
        {
          command: "tool",
          description: "Run the fixture tool",
          binaryName: "fixture-tool",
          hidden: true,
          unit: "rs-fixture-tool",
          component: "rs-fixture-tool",
          version: "0.0.1",
          tagPrefix: "v",
          tag: "v0.0.1",
          repository: "https://github.com/example/fixture",
          crateName: "fixture-tool",
          cargoFeatures: [],
          assets: [
            {
              os: "linux",
              cpu: "x64",
              name: "fixture-tool-linux-x64-gnu.tar.gz",
            },
          ],
        },
        {
          command: "tool-desktop",
          description: "Run the desktop fixture",
          binaryName: "fixture-tool-desktop",
          hidden: true,
          unit: "rs-fixture-tool",
          component: "rs-fixture-tool",
          version: "0.0.1",
          tagPrefix: "v",
          tag: "v0.0.1",
          repository: "https://github.com/example/fixture",
          crateName: "fixture-tool",
          cargoFeatures: ["desktop"],
          assets: [
            {
              os: "linux",
              cpu: "x64",
              name: "fixture-tool-desktop-linux-x64-gnu.tar.gz",
            },
            {
              os: "win32",
              cpu: "x64",
              name: "fixture-tool-desktop-win32-x64-msvc.zip",
            },
          ],
        },
      ]);
      const registry = readFileSync(
        join(directory, "packages/js/cli/root/src/_release-binaries.ts"),
        "utf8",
      );
      assert.match(registry, /export const RELEASE_BINARY_COMMANDS/);
      assert.match(registry, /fixture-tool-linux-x64-gnu\.tar\.gz/);
      assert.match(registry, /fixture-tool-desktop-win32-x64-msvc\.zip/);
      assert.doesNotMatch(registry, /"name": "fixture-tool-win32-x64-msvc\.zip"/);
      const configuration = readRustReleaseConfiguration(directory);
      const linux = configuration.targets.find((target) => target.os === "linux");
      const windows = configuration.targets.find((target) => target.os === "win32");
      assert.deepEqual(linux?.binaries, ["fixture-tool", "fixture-tool-desktop"]);
      assert.deepEqual(linux?.features, ["fixture-tool/desktop"]);
      assert.deepEqual(windows?.binaries, ["fixture-tool-desktop"]);
      assert.deepEqual(windows?.features, ["fixture-tool/desktop"]);
      assert.equal(readWorkflow(directory).jobs["rust-build"], undefined);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds every discovered binding once in each target job", () => {
    const multiOutdir = mkdtempSync(join(tmpdir(), "project-rs-multi-"));
    try {
      for (const crate of ["alpha", "beta"]) {
        mkdirSync(join(multiOutdir, `packages/rs/${crate}/src`), {
          recursive: true,
        });
        writeFileSync(
          join(multiOutdir, `packages/rs/${crate}/src/lib.rs`),
          "uniffi::setup_scaffolding!();\n",
        );
      }
      writeFileSync(join(multiOutdir, "Cargo.lock"), "version = 4\n");
      const project = new DBXToolsNodeProject({
        name: "@fixture/multi-root",
        scope: "fixture",
        outdir: multiOutdir,
        packageRoots: ["packages/js"],
        defaultTagMixins: false,
        github: true,
        nodeRelease: false,
      });
      new DBXToolsRustWorkspace(project, {
        releasePlatforms: [{ os: RustReleaseOs.LINUX, cpu: RustReleaseCpu.X64 }],
      });
      project.synth();

      const configuration = readRustReleaseConfiguration(multiOutdir);
      assert.deepEqual(configuration.targets[0]?.features, [
        "fixture-alpha/uniffi-bindgen",
        "fixture-beta/uniffi-bindgen",
      ]);
      assert.deepEqual(
        configuration.bindings.map((binding) => binding.crate),
        ["fixture-alpha", "fixture-beta"],
      );
      assert.equal(readWorkflow(multiOutdir).jobs["rust-build"], undefined);
    } finally {
      rmSync(multiOutdir, { recursive: true, force: true });
    }
  });

  it("installs only the Python tooling needed by Rust packaging", () => {
    const node = bindingReleaseConfiguration("node");
    assert.ok(node.bindings[0]?.node);
    assert.equal(node.bindings[0]?.python, "");

    const python = bindingReleaseConfiguration("python");
    assert.ok(python.bindings[0]?.python);
    assert.equal(python.bindings[0]?.node, "");
  });

  it("reads release platform filters without consumer-side environment parsing", () => {
    const filteredOutdir = mkdtempSync(join(tmpdir(), "project-rs-filtered-"));
    const previous = process.env.DBX_TOOLS_RELEASE_PLATFORMS;
    process.env.DBX_TOOLS_RELEASE_PLATFORMS = "linux:x64";
    try {
      mkdirSync(join(filteredOutdir, "native/tool/src"), { recursive: true });
      writeFileSync(join(filteredOutdir, "native/tool/src/main.rs"), "fn main() {}\n");
      const project = new DBXToolsNodeProject({
        name: "@fixture/filtered-root",
        scope: "fixture",
        outdir: filteredOutdir,
        packageRoots: ["packages/js"],
        defaultTagMixins: false,
        github: true,
        nodeRelease: false,
      });
      new DBXToolsRustWorkspace(project, {
        root: "native",
        packages: { tool: { release: true } },
      });
      project.synth();

      const matrix = readRustReleaseConfiguration(filteredOutdir).targets;
      assert.equal(matrix.length, 1);
      assert.deepEqual(matrix[0], {
        runner: "ubuntu-22.04",
        cargo: "x86_64-unknown-linux-gnu",
        node: "linux-x64-gnu",
        python: "manylinux_2_35_x86_64",
        os: "linux",
        cpu: "x64",
        libc: "glibc",
        glibcVersion: "2.35",
        packages: ["fixture-tool"],
        binaries: ["fixture-tool"],
        features: [],
        localFeatures: [],
      });
    } finally {
      if (previous === undefined) delete process.env.DBX_TOOLS_RELEASE_PLATFORMS;
      else process.env.DBX_TOOLS_RELEASE_PLATFORMS = previous;
      rmSync(filteredOutdir, { recursive: true, force: true });
    }
  });

  it("composes Rust, Python, and Node release stages from attached workspaces", () => {
    const chainOutdir = mkdtempSync(join(tmpdir(), "project-rs-chain-"));
    try {
      mkdirSync(join(chainOutdir, "native/addon/src"), { recursive: true });
      writeFileSync(
        join(chainOutdir, "native/addon/src/lib.rs"),
        "uniffi::setup_scaffolding!();\n",
      );
      const project = new DBXToolsNodeProject({
        name: "@fixture/root",
        scope: "fixture",
        outdir: chainOutdir,
        packageRoots: ["packages/js"],
        defaultTagMixins: false,
        github: true,
        repository: "https://github.com/example/fixture.git",
      });
      const rust = new DBXToolsRustWorkspace(project, {
        root: "native",
        pythonRoot: "python",
        releasePlatforms: [{ os: RustReleaseOs.LINUX, cpu: RustReleaseCpu.X64 }],
      });
      new DBXToolsPythonWorkspace(project, {
        root: "python",
        packages: [...rust.pythonPackages, { directory: "core", description: "Fixture core" }],
        release: true,
      });
      project.synth();

      const release = readWorkflow(chainOutdir);
      for (const job of ["publish-node", "build-python", "publish-pypi-addon-rs"]) {
        assert.ok(release.jobs[job], `missing ${job}`);
      }
      assert.equal(release.jobs["rust-build"], undefined);
      assert.equal(release.jobs["publish-native-npm"], undefined);
      assert.equal(release.jobs["publish-node-facades"], undefined);
      assert.equal(readRustReleaseConfiguration(chainOutdir).bindings.length, 1);
      assert.equal("repository_dispatch" in release.on, false);
      assert.equal("workflow_run" in release.on, false);
      assert.match(
        readFileSync(join(chainOutdir, "Cargo.toml"), "utf8"),
        /repository = "https:\/\/github\.com\/example\/fixture"/,
      );
    } finally {
      rmSync(chainOutdir, { recursive: true, force: true });
    }
  });

  it("discovers crates and marks generated packages for UniFFI publishing", () => {
    const project = new DBXToolsNodeProject({
      name: "@fixture/root",
      scope: "fixture",
      outdir,
      packageRoots: ["packages/js"],
      defaultTagMixins: false,
      github: true,
    });
    const rust = new DBXToolsRustWorkspace(project, {
      releasePlatforms: [
        { os: RustReleaseOs.DARWIN, cpu: RustReleaseCpu.ARM64 },
        { os: RustReleaseOs.LINUX, cpu: RustReleaseCpu.X64 },
      ],
      packages: {
        "databricks-auth": {
          dependencies: { uniffi: "0.31" },
          defaultFeatures: ["native"],
          features: { native: ["uniffi/tokio"] },
        },
        tool: {
          release: true,
        },
      },
    });
    project.synth();

    assert.equal(rust.packages[0]?.crateName, "fixture-databricks-auth");
    assert.equal(rust.pythonPackages.length, 1);
    assert.equal(rust.pythonPackages[0]?.name, "fixture-databricks-auth-rs");
    assert.equal(rust.pythonPackages[0]?.module, "fixture.databricks_auth_rs");
    assert.equal(rust.pythonPackages[0]?.uniffi, true);
    assert.deepEqual(rust.pythonPackages[0]?.generatedSources, [
      "src/fixture/databricks_auth_rs/bindings.py",
      "src/fixture/databricks_auth_rs/__init__.py",
    ]);
    assert.deepEqual(rust.pythonPackages[0]?.trustedPublisher, {
      environment: "pypi-fixture-databricks-auth-rs",
      artifacts:
        "platform-specific wheels for darwin-arm64, linux-x64; all architectures publish to this one PyPI project",
    });
    assert.deepEqual(rust.workspaceMapping, {
      root: "packages/rs",
      crates: ["packages/rs/databricks-auth", "packages/rs/tool"],
      bindings: [
        {
          crate: "fixture-databricks-auth",
          rust: "packages/rs/databricks-auth",
          node: "packages/js/node/databricks-auth-rs",
          nodePackage: "@fixture/databricks-auth-rs",
          python: "packages/py/databricks-auth-rs",
          pythonPackage: "fixture-databricks-auth-rs",
          pythonModule: "fixture.databricks_auth_rs",
        },
      ],
      binaries: [],
      openapi: [],
    });
    assert.deepEqual(project.dbxToolsConfig.rust, rust.workspaceMapping);
    assert.match(
      readFileSync(join(outdir, "packages/rs/databricks-auth/Cargo.toml"), "utf8"),
      /crate-type = \[\s*"lib", "cdylib"\s*\]/,
    );
    assert.match(readFileSync(join(outdir, "Cargo.toml"), "utf8"), /rust-version = "1\.82"/);
    const cargoConfig = readFileSync(join(outdir, ".cargo/config.toml"), "utf8");
    assert.match(cargoConfig, /\[target\.x86_64-pc-windows-msvc\]/);
    assert.match(cargoConfig, /\[target\.aarch64-pc-windows-msvc\]/);
    assert.equal(cargoConfig.match(/target-feature=\+crt-static/g)?.length, 2);
    assert.equal(existsSync(join(outdir, ".projen/cargo-cache-key.mjs")), false);
    const node = JSON.parse(
      readFileSync(join(outdir, "packages/js/node/databricks-auth-rs/package.json"), "utf8"),
    ) as {
      name: string;
      private?: boolean;
      dbxToolsConfig: { uniffi: boolean };
      dependencies: object;
      devDependencies: object;
      optionalDependencies: object;
      exports: Record<string, string>;
      publishConfig: {
        exports: Record<string, { types: string; default: string }>;
      };
    };
    assert.equal(node.name, "@fixture/databricks-auth-rs");
    assert.equal(node.private, undefined);
    assert.equal(node.dbxToolsConfig.uniffi, true);
    assert.equal("@fixture/databricks-auth-rs-darwin-arm64" in node.optionalDependencies, true);
    assert.equal("@fixture/databricks-auth-rs-linux-x64-gnu" in node.optionalDependencies, true);
    assert.equal("@fixture/databricks-auth-rs-darwin-x64" in node.optionalDependencies, false);
    assert.deepEqual(node.exports, { ".": "./index.ts", "./package.json": "./package.json" });
    assert.deepEqual(Object.keys(node.publishConfig.exports), [".", "./package.json"]);
    const gitignore = readFileSync(join(outdir, ".gitignore"), "utf8");
    const prettierignore = readFileSync(join(outdir, ".prettierignore"), "utf8");
    assert.match(gitignore, /^target\/$/m);
    assert.match(gitignore, /^!\/Cargo\.lock$/m);
    assert.doesNotMatch(gitignore, /^packages\/js\/node\/databricks-auth-rs\/src\/bindings\.ts$/m);
    assert.match(
      gitignore,
      /^packages\/js\/node\/databricks-auth-rs\/src\/\*fixture_databricks_auth\.\*$/m,
    );
    assert.match(prettierignore, /^packages\/js\/node\/databricks-auth-rs\/src\/bindings\.ts$/m);
    assert.match(prettierignore, /^packages\/js\/node\/databricks-auth-rs\/src\/_bindings\*\.ts$/m);
    assert.match(
      gitignore,
      /^packages\/py\/databricks-auth-rs\/src\/fixture\/databricks_auth_rs\/bindings\.py$/m,
    );
    const release = readWorkflow(outdir);
    const tasks = JSON.parse(readFileSync(join(outdir, ".projen/tasks.json"), "utf8")) as {
      tasks: Record<string, { steps?: Array<{ exec?: string; spawn?: string }> }>;
    };
    assert.deepEqual(tasks.tasks["pre-compile"]?.steps ?? [], []);
    assert.match(tasks.tasks["rs:bindings"]?.steps?.[0]?.exec ?? "", /tasks\/rust\.ts/);
    assert.equal("repository_dispatch" in release.on, false);
    assert.equal("workflow_run" in release.on, false);

    const configuration = readRustReleaseConfiguration(outdir);
    assert.deepEqual(
      configuration.targets.map((target) => target.node),
      ["darwin-arm64", "linux-x64-gnu"],
    );
    assert.deepEqual(
      configuration.bindings.map((binding) => binding.crate),
      ["fixture-databricks-auth"],
    );
    assert.equal(existsSync(join(outdir, ".projen/rust-release.json")), true);
    assert.equal(existsSync(join(outdir, ".projen/rust-release.mjs")), false);
    assert.equal(release.jobs["rust-build"], undefined);
    assert.equal(release.jobs["rust-assets"], undefined);
    assert.equal(existsSync(join(outdir, ".github/workflows/rust-cache.yml")), false);
    const cargoPublisher = release.jobs["publish-cargo"]!;
    assert.deepEqual(stepNames(cargoPublisher), [
      "Checkout release commit",
      "Verify release source",
      "Setup Rust",
      "Publish public crates",
    ]);
    assert.equal(
      cargoPublisher.if,
      "${{ always() && (needs.verify-context.result == 'success') && (github.event_name == 'release' || (inputs.dry_run != true && (inputs.stage == 'all' || inputs.stage == 'cargo'))) }}",
    );
    const cargoPublish = workflowStep(cargoPublisher, "Publish public crates").run!;
    assert.ok(cargoPublish.includes('--package "fixture-databricks-auth"'));
    assert.ok(cargoPublish.includes('--package "fixture-tool"'));
    assert.ok(cargoPublish.includes("cargo info"));
    assert.ok(cargoPublish.includes("--registry crates-io --locked"));
    assert.doesNotMatch(cargoPublish, /--no-verify/);
    assert.equal(release.jobs["publish-local-cargo"], undefined);
    assert.equal(release.jobs["publish-native-npm"], undefined);
    assert.equal(release.jobs["publish-node-facades"], undefined);
    assert.equal(release.jobs["publish-github-release"], undefined);
    const nodePublisher = release.jobs["publish-node"]!;
    assert.equal(nodePublisher.needs, "verify-context");
    assert.ok(
      workflowStep(nodePublisher, "Download approved npm archives").run?.includes(
        "release-manifest.ts verify",
      ),
    );
    assert.ok(
      workflowStep(nodePublisher, "Publish approved npm archives").run?.includes("publish-npm.ts"),
    );
    const packager = readFileSync(join(outdir, ".projen/uniffi-release.mjs"), "utf8");
    assert.ok(packager.includes('"node_modules", "npm", "bin", "npm-cli.js"'));
    assert.ok(packager.includes("command: process.execPath, args: [npmCli, ...args]"));
    assert.ok(packager.includes("repository: sourceManifest.repository"));
    assert.ok(packager.includes("npmPackageBase:"));
    assert.match(packager, /cargoTargetRoot/);
    assert.match(packager, /generatorTarget \?\? cargoTarget/);
    assert.match(packager, /"generator-target"/);
    assert.match(packager, /installPythonBindings/);
    assert.match(packager, /preparePythonProjectForPublication/);
    assert.doesNotMatch(packager, /resolve\(\s*root,\s*"target",\s*cargoTarget/);
    assert.equal(packager.includes('required("ubrn")'), false);
    assert.equal(packager.includes('run("cargo", ["run"'), false);
    assert.equal(existsSync(join(outdir, ".projen/uniffi-python.js")), true);
    assert.equal(existsSync(join(outdir, ".projen/smol-toml.cjs")), true);
    assert.equal(existsSync(join(outdir, ".projen/smol-toml.LICENSE")), true);
    const cargo = parse(
      readFileSync(join(outdir, "packages/rs/databricks-auth/Cargo.toml"), "utf8"),
    ) as {
      bin: Array<{ name: string; path: string; "required-features": string[] }>;
      features: Record<string, string[]>;
      package: Record<string, unknown>;
    };
    assert.deepEqual(cargo.bin, [
      {
        name: "fixture-databricks-auth-uniffi-bindgen",
        path: "uniffi-bindgen.rs",
        "required-features": ["uniffi-bindgen"],
      },
    ]);
    assert.deepEqual(cargo.features, {
      default: ["native"],
      native: ["uniffi/tokio"],
      "uniffi-bindgen": ["uniffi/cli"],
    });
    assert.deepEqual(cargo.package.version, { workspace: true });
    const cargoConfiguration = parse(readFileSync(join(outdir, ".cargo/config.toml"), "utf8")) as {
      target: Record<string, { rustflags: string[] }>;
    };
    assert.deepEqual(cargoConfiguration.target["x86_64-pc-windows-msvc"]?.rustflags, [
      "-C",
      "target-feature=+crt-static",
    ]);
    const nodeGenerator = readFileSync(
      join(import.meta.dirname, "..", "tasks", "uniffi.ts"),
      "utf8",
    );
    assert.match(nodeGenerator, /values\.ubrn \? resolve\(values\.ubrn\)/);
    assert.match(nodeGenerator, /target_directory/);
    assert.match(nodeGenerator, /if \(!values\["skip-barrels"\]\)/);
    assert.equal(rust.pythonPackages.length, 1);
    assert.equal(existsSync(join(outdir, "packages/js/node/databricks-auth-rs/exports.ts")), false);
  });

  it("keeps generated bindings in a dedicated Node package", () => {
    const directory = mkdtempSync(join(tmpdir(), "project-rs-existing-node-"));
    try {
      mkdirSync(join(directory, "packages/rs/databricks/src"), { recursive: true });
      writeFileSync(
        join(directory, "packages/rs/databricks/src/lib.rs"),
        "uniffi::setup_scaffolding!();\n",
      );
      mkdirSync(join(directory, "packages/js/node/databricks/src"), { recursive: true });
      writeFileSync(
        join(directory, "packages/js/node/databricks/src/direct.ts"),
        "export const direct = true;\n",
      );
      const project = new DBXToolsNodeProject({
        name: "@fixture/root",
        scope: "fixture",
        outdir: directory,
        packageRoots: ["packages/js"],
        defaultTagMixins: false,
        github: false,
      });
      new DBXToolsRustWorkspace(project, {
        scope: "fixture",
        release: false,
      });
      project.synth();

      const manifest = JSON.parse(
        readFileSync(join(directory, "packages/js/node/databricks-rs/package.json"), "utf8"),
      ) as {
        private?: boolean;
        description: string;
        dbxToolsConfig: { uniffi: boolean };
      };
      assert.equal(manifest.private, undefined);
      assert.equal(manifest.description, "Node bindings for fixture-databricks");
      assert.equal(manifest.dbxToolsConfig.uniffi, true);
      assert.equal(
        readFileSync(join(directory, "packages/js/node/databricks/src/direct.ts"), "utf8"),
        "export const direct = true;\n",
      );
      assert.equal(
        existsSync(join(directory, "packages/js/node/databricks-rs/src/direct.ts")),
        false,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("applies a workspace private default with per-crate overrides", () => {
    const project = new DBXToolsNodeProject({
      name: "@fixture/private-root",
      scope: "fixture",
      outdir: join(outdir, "private"),
      packageRoots: ["packages/js"],
      defaultTagMixins: false,
      github: false,
    });
    mkdirSync(join(project.outdir, "packages/rs/private-cli/src"), { recursive: true });
    writeFileSync(join(project.outdir, "packages/rs/private-cli/src/main.rs"), "fn main() {}\n");
    mkdirSync(join(project.outdir, "packages/rs/public-cli/src"), { recursive: true });
    writeFileSync(join(project.outdir, "packages/rs/public-cli/src/main.rs"), "fn main() {}\n");
    new DBXToolsRustWorkspace(project, {
      scope: "fixture",
      private: true,
      packages: { "public-cli": { private: false } },
    });
    project.synth();
    const privateManifest = readFileSync(
      join(project.outdir, "packages/rs/private-cli/Cargo.toml"),
      "utf8",
    );
    const publicManifest = readFileSync(
      join(project.outdir, "packages/rs/public-cli/Cargo.toml"),
      "utf8",
    );
    assert.match(privateManifest, /^publish = false$/m);
    assert.match(privateManifest, /\[\[bin\]\]\nname = "fixture-private-cli"/);
    assert.doesNotMatch(publicManifest, /^publish = false$/m);
  });
});
