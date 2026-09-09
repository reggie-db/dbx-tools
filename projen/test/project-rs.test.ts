import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  readWorkflow,
  workflowStep,
  type WorkflowDefinition,
  type WorkflowJob,
} from "./workflow.ts";
import {
  DBXToolsNodeProject,
  DBXToolsPythonWorkspace,
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

function bindingWorkflow(binding: "node" | "python"): WorkflowDefinition {
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
    return readWorkflow(bindingOutdir);
  } finally {
    rmSync(bindingOutdir, { recursive: true, force: true });
  }
}

function stepNames(job: WorkflowJob): string[] {
  return job.steps.flatMap((step) => (step.name ? [step.name] : []));
}

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
      assert.equal("rust-build" in readWorkflow(emptyOutdir).jobs, false);
      assert.equal(existsSync(join(emptyOutdir, ".github/workflows/rust-cache.yml")), false);
      assert.equal(existsSync(join(emptyOutdir, ".github/workflows/release-dispatch.yml")), false);
    } finally {
      rmSync(emptyOutdir, { recursive: true, force: true });
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
      const buildJob = release.jobs["rust-build"]!;
      assert.ok(stepNames(buildJob).includes("Package release binaries"));
      assert.equal(
        stepNames(buildJob).some((name) => /Setup Bun|Setup Node\.js|Setup uv/.test(name)),
        false,
      );
      assert.equal(
        buildJob.steps.some((step) => step.run === "bun install"),
        false,
      );
      const cargoJob = release.jobs["publish-cargo"]!;
      assert.equal(
        stepNames(cargoJob).some((name) => /Setup Bun|Setup Node\.js|Setup uv/.test(name)),
        false,
      );
      assert.deepEqual(stepNames(release.jobs["publish-github-release"]!), [
        "Download release binaries",
        "Publish GitHub release assets",
      ]);
      assert.equal(existsSync(join(binaryOutdir, ".projen/uniffi-release.mjs")), false);
    } finally {
      rmSync(binaryOutdir, { recursive: true, force: true });
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

      const buildJob = readWorkflow(platformOutdir).jobs["rust-build"]!;
      const matrix = buildJob.strategy?.matrix?.include ?? [];
      assert.equal(matrix.find((target) => target.os === "linux")?.cargoExcludes, "");
      assert.deepEqual(
        matrix
          .filter((target) => target.os === "win32")
          .map((target) => [target.cpu, target.cargoExcludes]),
        [
          ["x64", "--exclude fixture-platform-helper"],
          ["arm64", "--exclude fixture-platform-helper"],
        ],
      );
      assert.ok(
        workflowStep(buildJob, "Build Rust outputs").run?.includes("${{ matrix.cargoExcludes }}"),
      );
      assert.ok(
        workflowStep(buildJob, "Package release binaries").run?.includes(
          'if [ "${{ matrix.os }}" != "win32" ]; then',
        ),
      );
      assert.equal(
        workflowStep(buildJob, "Upload fixture-platform-helper release binary").if,
        "${{ matrix.os != 'win32' }}",
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
        cliRegistryPath: "packages/js/cli/root/src/_rust-release-binaries.ts",
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
            cli: { command: "tool" },
          },
        },
      });
      project.synth();

      assert.deepEqual(rust.releaseBinaries, [
        {
          command: "tool",
          description: "Run the fixture tool",
          binaryName: "fixture-tool",
          repository: "https://github.com/example/fixture",
          assets: [
            {
              os: "linux",
              cpu: "x64",
              name: "fixture-tool-linux-x64-gnu.tar.gz",
            },
          ],
        },
      ]);
      const registry = readFileSync(
        join(directory, "packages/js/cli/root/src/_rust-release-binaries.ts"),
        "utf8",
      );
      assert.match(registry, /export const RUST_RELEASE_BINARY_COMMANDS/);
      assert.match(registry, /fixture-tool-linux-x64-gnu\.tar\.gz/);
      assert.doesNotMatch(registry, /win32-x64-msvc/);
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

      const buildJob = readWorkflow(multiOutdir).jobs["rust-build"]!;
      assert.equal(
        workflowStep(buildJob, "Build Rust outputs").run?.match(
          /cargo build --release --workspace(?: --locked)? --target/g,
        )?.length,
        1,
      );
      assert.match(
        workflowStep(buildJob, "Build Rust outputs").run ?? "",
        /cargo build --release --workspace --locked --target/,
      );
      const packageBindings = workflowStep(buildJob, "Package UniFFI outputs").run!;
      assert.ok(packageBindings.includes('--crate "fixture-alpha"'));
      assert.ok(packageBindings.includes('--crate "fixture-beta"'));
      assert.equal(
        stepNames(buildJob).filter((name) => name === "Cache Cargo registry and targets").length,
        1,
      );
      assert.equal(stepNames(buildJob).includes("Setup sccache"), false);
      assert.equal(
        stepNames(buildJob).filter((name) => name === "Install Linux native dependencies").length,
        1,
      );
      assert.match(
        workflowStep(buildJob, "Install Linux native dependencies").run ?? "",
        /rm -f \/etc\/apt\/sources\.list\.d\/google-chrome\.list/,
      );
      assert.equal(stepNames(buildJob).includes("Setup Bun"), false);
    } finally {
      rmSync(multiOutdir, { recursive: true, force: true });
    }
  });

  it("installs only the Python tooling needed by Rust packaging", () => {
    const nodeWorkflow = bindingWorkflow("node");
    const nodeBuild = nodeWorkflow.jobs["rust-build"]!;
    assert.equal(
      stepNames(nodeBuild).some((name) => name === "Setup Bun" || name === "Setup uv"),
      false,
    );

    const pythonWorkflow = bindingWorkflow("python");
    const pythonBuild = pythonWorkflow.jobs["rust-build"]!;
    assert.equal(stepNames(pythonBuild).includes("Setup uv"), true);
    assert.equal(stepNames(pythonBuild).includes("Setup Bun"), false);
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

      assert.deepEqual(readWorkflow(filteredOutdir).jobs["rust-build"]?.strategy?.matrix?.include, [
        {
          runner: "ubuntu-22.04",
          cargo: "x86_64-unknown-linux-gnu",
          node: "linux-x64-gnu",
          python: "manylinux_2_35_x86_64",
          os: "linux",
          cpu: "x64",
          libc: "glibc",
        },
      ]);
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
      for (const job of [
        "rust-build",
        "publish-native-npm",
        "publish-node",
        "publish-node-facades",
        "build-python",
        "publish-pypi-addon-rs",
      ]) {
        assert.ok(release.jobs[job], `missing ${job}`);
      }
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
        "databricks-auth": { dependencies: { uniffi: "0.31" } },
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
    });
    assert.deepEqual(project.dbxToolsConfig.rust, rust.workspaceMapping);
    assert.match(
      readFileSync(join(outdir, "packages/rs/databricks-auth/Cargo.toml"), "utf8"),
      /crate-type = \["lib", "cdylib"\]/,
    );
    assert.match(readFileSync(join(outdir, "Cargo.toml"), "utf8"), /rust-version = "1\.82"/);
    const cargoConfig = readFileSync(join(outdir, ".cargo/config.toml"), "utf8");
    assert.match(cargoConfig, /\[target\.x86_64-pc-windows-msvc\]/);
    assert.match(cargoConfig, /\[target\.aarch64-pc-windows-msvc\]/);
    assert.equal(cargoConfig.match(/target-feature=\+crt-static/g)?.length, 2);
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
      tasks: Record<string, { steps?: Array<{ spawn?: string }> }>;
    };
    assert.deepEqual(tasks.tasks["pre-compile"]?.steps, [{ spawn: "rs:bindings" }]);
    assert.equal("repository_dispatch" in release.on, false);
    assert.equal("workflow_run" in release.on, false);

    const rustBuild = release.jobs["rust-build"]!;
    assert.equal(rustBuild.if, "${{ github.event_name == 'push' || inputs.stage == 'all' }}");
    assert.deepEqual(
      rustBuild.strategy?.matrix?.include?.map((target) => target.node),
      ["darwin-arm64", "linux-x64-gnu"],
    );
    assert.deepEqual(rustBuild.env, {
      CARGO_INCREMENTAL: "0",
      CARGO_TERM_COLOR: "always",
    });
    assert.equal(workflowStep(rustBuild, "Setup Rust").uses, "dtolnay/rust-toolchain@stable");
    assert.equal(workflowStep(rustBuild, "Setup Rust").if, "${{ matrix.os != 'win32' }}");
    assert.equal(stepNames(rustBuild).includes("Verify preinstalled Windows Rust"), true);
    assert.equal(stepNames(rustBuild).includes("Setup Bun"), false);
    assert.ok(
      workflowStep(rustBuild, "Build Rust outputs").run?.includes(
        'cargo build --release --workspace --target "${{ matrix.cargo }}"',
      ),
    );
    assert.ok(workflowStep(rustBuild, "Package UniFFI outputs").run?.includes("--skip-build"));
    assert.ok(workflowStep(rustBuild, "Package release binaries").run?.includes("7z a"));
    assert.deepEqual(
      rustBuild.steps
        .filter((candidate) => candidate.uses === "actions/upload-artifact@v7")
        .map((candidate) => candidate.with?.name),
      [
        "fixture-databricks-auth-${{ matrix.node }}-npm",
        "fixture-databricks-auth-rs--${{ matrix.python }}--python-wheel",
        "fixture-tool-${{ matrix.node }}-binary",
      ],
    );
    assert.deepEqual(workflowStep(rustBuild, "Cache Cargo registry and targets").with, {
      "cache-targets": true,
      "cache-workspace-crates": false,
      "add-job-id-key": false,
      "add-rust-environment-hash-key": true,
      "shared-key": "release-${{ matrix.cargo }}-rust-stable",
      "save-if": false,
    });
    const cacheWorkflow = readWorkflow(outdir, "rust-cache");
    assert.deepEqual(cacheWorkflow.on.workflow_dispatch, {});
    const cachePrime = cacheWorkflow.jobs.prime!;
    assert.equal(stepNames(cachePrime).includes("Setup uv"), false);
    assert.match(
      workflowStep(cachePrime, "Prime Cargo target cache").run ?? "",
      /cargo build --release --workspace --target/,
    );
    assert.equal(
      workflowStep(cachePrime, "Cache Cargo registry and targets").with?.["save-if"],
      true,
    );

    const cargoPublisher = release.jobs["publish-cargo"]!;
    assert.deepEqual(stepNames(cargoPublisher), [
      "Checkout release commit",
      "Verify release source",
      "Setup Rust",
      "Publish public crates",
    ]);
    const cargoPublish = workflowStep(cargoPublisher, "Publish public crates").run!;
    assert.ok(cargoPublish.includes('--package "fixture-databricks-auth"'));
    assert.ok(cargoPublish.includes('--package "fixture-tool"'));
    assert.ok(release.jobs["publish-local-cargo"]);

    const nativeNpm = release.jobs["publish-native-npm"]!;
    assert.deepEqual(nativeNpm.needs, ["verify-context", "rust-build"]);
    assert.deepEqual(nativeNpm.permissions, {
      actions: "read",
      contents: "read",
      "id-token": "write",
    });
    assert.equal(
      workflowStep(nativeNpm, "Download recovered native npm packages").with?.["run-id"],
      "${{ inputs.source_run_id }}",
    );
    assert.equal(
      workflowStep(nativeNpm, "Publish native npm packages").env?.NPM_CONFIG_PROVENANCE,
      "${{ (github.event_name == 'push' || inputs.dry_run == false) && 'true' || 'false' }}",
    );
    assert.ok(
      workflowStep(nativeNpm, "Publish native npm packages").run?.includes("publish-npm.ts"),
    );
    assert.deepEqual(release.jobs["publish-node"]?.needs, ["verify-context", "publish-native-npm"]);
    assert.ok(release.jobs["publish-node"]?.if?.includes("needs.publish-native-npm.result"));
    const nodeFacades = release.jobs["publish-node-facades"]!;
    assert.deepEqual(nodeFacades.needs, ["verify-context", "publish-node"]);
    const facadePublish = workflowStep(nodeFacades, "Build and publish UniFFI npm facades");
    assert.ok(facadePublish.run?.includes("uniffi-release.mjs facade"));
    assert.ok(facadePublish.run?.includes("publish-npm.ts"));
    assert.equal(facadePublish.run?.includes("--native-package"), false);
    assert.equal(
      facadePublish.env?.NPM_CONFIG_PROVENANCE,
      "${{ (github.event_name == 'push' || inputs.dry_run == false) && 'true' || 'false' }}",
    );
    const smoke = workflowStep(nodeFacades, "Smoke test published UniFFI npm facades");
    assert.equal(smoke["continue-on-error"], true);
    assert.equal(
      smoke.if,
      "${{ github.event_name == 'push' && vars.UNIFFI_FACADE_SMOKE == 'true' }}",
    );
    assert.equal(
      workflowStep(release.jobs["publish-github-release"]!, "Publish GitHub release assets").uses,
      "softprops/action-gh-release@v2",
    );
    const packager = readFileSync(join(outdir, ".projen/uniffi-release.mjs"), "utf8");
    assert.ok(packager.includes('"node_modules", "npm", "bin", "npm-cli.js"'));
    assert.ok(packager.includes("command: process.execPath, args: [npmCli, ...args]"));
    assert.ok(packager.includes("repository: sourceManifest.repository"));
    assert.ok(packager.includes("npmPackageBase:"));
    assert.match(packager, /cargoTargetRoot/);
    assert.doesNotMatch(packager, /resolve\(\s*root,\s*"target",\s*cargoTarget/);
    assert.equal(packager.includes('required("ubrn")'), false);
    assert.equal(packager.includes('run("cargo", ["run"'), false);
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

  it("marks private crates as unpublished", () => {
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
    new DBXToolsRustWorkspace(project, {
      scope: "fixture",
      packages: { "private-cli": { private: true } },
    });
    project.synth();
    const manifest = readFileSync(
      join(project.outdir, "packages/rs/private-cli/Cargo.toml"),
      "utf8",
    );
    assert.match(manifest, /^publish = false$/m);
    assert.match(manifest, /\[\[bin\]\]\nname = "fixture-private-cli"/);
  });
});
