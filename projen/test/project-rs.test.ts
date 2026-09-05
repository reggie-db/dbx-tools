import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
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

function bindingWorkflow(binding: "node" | "python"): string {
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
      nodeReleaseWorkflowName: false,
    });
    new DBXToolsRustWorkspace(project, {
      root: "native",
      releasePlatforms: [{ os: RustReleaseOs.LINUX, cpu: RustReleaseCpu.X64 }],
      packages: { addon: { bindings: [binding] } },
    });
    project.synth();
    return readFileSync(join(bindingOutdir, ".github/workflows/rust-release.yml"), "utf8");
  } finally {
    rmSync(bindingOutdir, { recursive: true, force: true });
  }
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
        nodeReleaseWorkflowName: false,
      });
      const rust = new DBXToolsRustWorkspace(project, {
        workspaceDependencies: { shared: { package: "fixture-auth", path: "packages/rs/auth" } },
        packages: { provider: { dependencies: { shared: { workspace: true } } } },
      });
      project.synth();
      assert.deepEqual(
        rust.pythonPackages.find((pkg) => pkg.directory === "provider")?.internalDependencies,
        ["auth"],
      );
      const manifest = JSON.parse(
        readFileSync(join(directory, "packages/js/node/provider/package.json"), "utf8"),
      );
      assert.equal(manifest.dependencies["@fixture/auth"], "workspace:*");
      assert.match(
        readFileSync(join(directory, "packages/rs/provider/uniffi.toml"), "utf8"),
        /fixture_auth = "fixture.auth.bindings"/,
      );
      assert.deepEqual(
        rust.bindingMappings.find((binding) => binding.crate === "fixture-provider")?.dependencies,
        ["fixture-auth"],
      );
      assert.match(
        readFileSync(join(directory, ".github/workflows/rust-release.yml"), "utf8"),
        /publish-fixture-provider:[\s\S]*?needs:[\s\S]*?publish-fixture-auth/,
      );
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
        nodeReleaseWorkflowName: false,
      });
      new DBXToolsRustWorkspace(project, {});
      project.synth();
      assert.equal(existsSync(join(emptyOutdir, ".github/workflows/rust-release.yml")), false);
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
        nodeReleaseWorkflowName: false,
      });
      new DBXToolsRustWorkspace(project, {
        releasePlatforms: [{ os: RustReleaseOs.LINUX, cpu: RustReleaseCpu.X64 }],
        packages: { tool: { release: true } },
      });
      project.synth();

      const release = readFileSync(
        join(binaryOutdir, ".github/workflows/rust-release.yml"),
        "utf8",
      );
      assert.match(release, /name: \$\{\{ matrix\.target\.node \}\}/);
      assert.match(release, /name: Package release binaries/);
      const buildJob = release.match(/^  build:[\s\S]*?(?=^  publish-cargo:)/m)?.[0];
      assert.ok(buildJob);
      assert.doesNotMatch(buildJob, /Setup Bun|Setup Node\.js|Setup uv|bun install/);
      const cargoJob = release.match(
        /^  publish-cargo:[\s\S]*?(?=^  publish-local-|^  publish-github-release:)/m,
      )?.[0];
      assert.ok(cargoJob);
      assert.doesNotMatch(cargoJob, /Setup Bun|Setup Node\.js|Setup uv|bun install/);
      const githubJob = release.match(/^  publish-github-release:[\s\S]*/m)?.[0];
      assert.ok(githubJob);
      assert.doesNotMatch(githubJob, /Checkout|Setup Bun|Setup Node\.js|Setup uv|Setup Rust/);
      assert.equal(existsSync(join(binaryOutdir, ".projen/uniffi-release.mjs")), false);
    } finally {
      rmSync(binaryOutdir, { recursive: true, force: true });
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
      const project = new DBXToolsNodeProject({
        name: "@fixture/multi-root",
        scope: "fixture",
        outdir: multiOutdir,
        packageRoots: ["packages/js"],
        defaultTagMixins: false,
        github: true,
        nodeReleaseWorkflowName: false,
      });
      new DBXToolsRustWorkspace(project, {
        releasePlatforms: [{ os: RustReleaseOs.LINUX, cpu: RustReleaseCpu.X64 }],
      });
      project.synth();

      const release = readFileSync(join(multiOutdir, ".github/workflows/rust-release.yml"), "utf8");
      const buildJob = release.match(/^  build:[\s\S]*?(?=^  publish-)/m)?.[0];
      assert.ok(buildJob);
      assert.equal(buildJob.match(/cargo build --release --workspace --target/g)?.length, 1);
      assert.match(buildJob, /--crate "fixture-alpha"/);
      assert.match(buildJob, /--crate "fixture-beta"/);
      assert.equal(buildJob.match(/name: Setup sccache/g)?.length, 1);
      assert.equal(buildJob.match(/name: Install Linux native dependencies/g)?.length, 1);
      assert.equal(buildJob.match(/name: Prepare UBRN generator/g)?.length, 1);
      assert.match(buildJob, /name: Restore UBRN executable/);
    } finally {
      rmSync(multiOutdir, { recursive: true, force: true });
    }
  });

  it("installs language tooling only for discovered binding targets", () => {
    const nodeWorkflow = bindingWorkflow("node");
    const nodeBuild = nodeWorkflow.match(/^  build:[\s\S]*?(?=^  publish-)/m)?.[0];
    assert.ok(nodeBuild);
    assert.match(nodeBuild, /name: Setup Bun/);
    assert.match(nodeBuild, /bun install/);
    assert.doesNotMatch(nodeBuild, /name: Setup uv/);

    const pythonWorkflow = bindingWorkflow("python");
    const pythonBuild = pythonWorkflow.match(/^  build:[\s\S]*?(?=^  publish-)/m)?.[0];
    assert.ok(pythonBuild);
    assert.match(pythonBuild, /name: Setup uv/);
    assert.doesNotMatch(pythonBuild, /name: Setup Bun|bun install/);
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
        nodeReleaseWorkflowName: false,
      });
      new DBXToolsRustWorkspace(project, {
        root: "native",
        packages: { tool: { release: true } },
      });
      project.synth();

      const release = readFileSync(
        join(filteredOutdir, ".github/workflows/rust-release.yml"),
        "utf8",
      );
      assert.match(release, /cargo: x86_64-unknown-linux-gnu/);
      assert.doesNotMatch(release, /aarch64-unknown-linux-gnu|apple-darwin|windows-msvc/);
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

      const pythonRelease = readFileSync(
        join(chainOutdir, ".github/workflows/python-release.yml"),
        "utf8",
      );
      const nodeRelease = readFileSync(
        join(chainOutdir, ".github/workflows/node-release.yml"),
        "utf8",
      );
      assert.match(pythonRelease, /^  repository_dispatch:\n    types:\n      - release$/m);
      assert.match(nodeRelease, /^  repository_dispatch:\n    types:\n      - release$/m);
      assert.doesNotMatch(pythonRelease, /workflow_run:/);
      assert.doesNotMatch(nodeRelease, /workflow_run:/);
      assert.match(
        readFileSync(join(chainOutdir, "Cargo.toml"), "utf8"),
        /repository = "https:\/\/github\.com\/example\/fixture"/,
      );
    } finally {
      rmSync(chainOutdir, { recursive: true, force: true });
    }
  });

  it("discovers crates and derives private UniFFI packages", () => {
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
          nodeDependencies: ["pg@^8"],
          nodeDevDependencies: ["@types/pg@^8"],
        },
        tool: {
          release: true,
        },
      },
    });
    project.synth();

    assert.equal(rust.packages[0]?.crateName, "fixture-databricks-auth");
    assert.equal(rust.pythonPackages.length, 1);
    assert.equal(rust.pythonPackages[0]?.name, "fixture-databricks-auth");
    assert.equal(rust.pythonPackages[0]?.module, "fixture.databricks_auth");
    assert.equal(rust.pythonPackages[0]?.private, true);
    assert.deepEqual(rust.pythonPackages[0]?.generatedSources, [
      "src/fixture/databricks_auth/bindings.py",
    ]);
    assert.deepEqual(rust.pythonPackages[0]?.trustedPublisher, {
      workflowName: "rust-release",
      environment: "pypi-fixture-databricks-auth",
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
          node: "packages/js/node/databricks-auth",
          nodePackage: "@fixture/databricks-auth",
          python: "packages/py/databricks-auth",
          pythonPackage: "fixture-databricks-auth",
          pythonModule: "fixture.databricks_auth",
        },
      ],
      releaseWorkflow: "rust-release",
    });
    assert.deepEqual(project.dbxToolsConfig.rust, rust.workspaceMapping);
    assert.match(
      readFileSync(join(outdir, "packages/rs/databricks-auth/Cargo.toml"), "utf8"),
      /crate-type = \["lib", "cdylib"\]/,
    );
    assert.match(readFileSync(join(outdir, "Cargo.toml"), "utf8"), /rust-version = "1\.82"/);
    const node = JSON.parse(
      readFileSync(join(outdir, "packages/js/node/databricks-auth/package.json"), "utf8"),
    ) as {
      name: string;
      private: boolean;
      dependencies: object;
      devDependencies: object;
      optionalDependencies: object;
      exports: Record<string, string>;
      publishConfig: {
        exports: Record<string, { types: string; default: string }>;
      };
    };
    assert.equal(node.name, "@fixture/databricks-auth");
    assert.equal(node.private, true);
    assert.equal("pg" in node.dependencies, true);
    assert.equal("@types/pg" in node.devDependencies, true);
    assert.equal("@fixture/databricks-auth-darwin-arm64" in node.optionalDependencies, true);
    assert.equal("@fixture/databricks-auth-linux-x64-gnu" in node.optionalDependencies, true);
    assert.equal("@fixture/databricks-auth-darwin-x64" in node.optionalDependencies, false);
    assert.deepEqual(node.exports, { ".": "./index.ts", "./package.json": "./package.json" });
    assert.deepEqual(Object.keys(node.publishConfig.exports), [".", "./package.json"]);
    const gitignore = readFileSync(join(outdir, ".gitignore"), "utf8");
    const prettierignore = readFileSync(join(outdir, ".prettierignore"), "utf8");
    assert.match(gitignore, /^target\/$/m);
    assert.doesNotMatch(gitignore, /^packages\/js\/node\/databricks-auth\/src\/bindings\.ts$/m);
    assert.match(
      gitignore,
      /^packages\/js\/node\/databricks-auth\/src\/\*fixture_databricks_auth\.\*$/m,
    );
    assert.match(prettierignore, /^packages\/js\/node\/databricks-auth\/src\/bindings\.ts$/m);
    assert.match(prettierignore, /^packages\/js\/node\/databricks-auth\/src\/_bindings\*\.ts$/m);
    assert.match(
      gitignore,
      /^packages\/py\/databricks-auth\/src\/fixture\/databricks_auth\/bindings\.py$/m,
    );
    const release = readFileSync(join(outdir, ".github/workflows/rust-release.yml"), "utf8");
    const dispatcher = readFileSync(join(outdir, ".github/workflows/release-dispatch.yml"), "utf8");
    const tasks = readFileSync(join(outdir, ".projen/tasks.json"), "utf8");
    assert.match(tasks, /"pre-compile": \{[\s\S]*?"spawn": "rs:bindings"[\s\S]*?\n    \}/);
    assert.match(dispatcher, /^  push:\n    tags:\n      - v\*$/m);
    assert.match(dispatcher, /EXPECTED_SHA="\$\(git rev-parse "\$RELEASE_TAG\^\{commit\}"\)"/);
    assert.match(dispatcher, /gh api --method POST "repos\/\$GITHUB_REPOSITORY\/dispatches"/);
    assert.match(dispatcher, /--raw-field event_type="\$RELEASE_EVENT"/);
    assert.match(dispatcher, /client_payload\[release_tag\]=\$RELEASE_TAG/);
    assert.match(dispatcher, /client_payload\[expected_sha\]=\$EXPECTED_SHA/);
    assert.match(dispatcher, /RELEASE_EVENT: rust-release/);
    assert.match(dispatcher, /RELEASE_WORKFLOWS: rust-release,node-release/);
    assert.match(dispatcher, /gh run cancel "\$run_id"/);
    assert.doesNotMatch(dispatcher, /actions\/cache|cargo build|sccache/);
    assert.match(dispatcher, /fetch-depth: 1/);
    assert.match(release, /^  repository_dispatch:\n    types:\n      - rust-release$/m);
    assert.match(release, /^  cancel-in-progress: true$/m);
    assert.match(release, /^  workflow_dispatch:$/m);
    assert.doesNotMatch(release, /^  push:$/m);
    assert.match(release, /github\.event\.client_payload\.expected_sha \|\| inputs\.expected_sha/);
    assert.doesNotMatch(release, /fetch-depth: 0/);
    assert.match(
      release,
      /test "\$\(git rev-parse "\$RELEASE_TAG\^\{commit\}"\)" = "\$EXPECTED_SHA"/,
    );
    assert.match(release, /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/);
    assert.match(release, /fixture-databricks-auth/);
    assert.match(release, /linux-x64-gnu/);
    assert.match(release, /darwin-arm64/);
    assert.doesNotMatch(release, /linux-arm64-gnu/);
    assert.doesNotMatch(release, /darwin-x64/);
    assert.doesNotMatch(release, /win32-x64-msvc/);
    assert.match(
      readFileSync(join(outdir, ".github/workflows/node-release.yml"), "utf8"),
      /^  repository_dispatch:\n    types:\n      - release$/m,
    );
    assert.match(release, /^  dispatch-downstream:$/m);
    assert.match(release, /RELEASE_EVENT: release/);
    assert.equal(release.match(/^          - target:$/gm)?.length, 2);
    assert.doesNotMatch(release, /^  build-binaries:$/m);
    assert.match(release, /cargo build --release --workspace --target/);
    assert.match(release, /node \.projen\/uniffi-release\.mjs build/);
    assert.match(release, /--skip-build/);
    assert.match(release, /name: Restore UBRN executable/);
    assert.match(release, /uses: actions\/cache\/restore@v5/);
    assert.match(release, /name: Restore Bun cache/);
    assert.match(release, /name: Save Bun cache/);
    assert.match(release, /^      BUN_VERSION: 1\.3\.14$/m);
    assert.match(
      release,
      /name: Setup Bun\n        if: \$\{\{ matrix\.target\.facade \}\}\n        uses: oven-sh\/setup-bun@v2/,
    );
    assert.match(
      release,
      /name: Resolve Bun cache[\s\S]*?if: \$\{\{ matrix\.target\.facade && steps\.ubrn_cache\.outputs\.cache-hit != 'true' \}\}/,
    );
    assert.match(
      release,
      /name: Restore UBRN executable[\s\S]*?if: \$\{\{ matrix\.target\.facade \}\}/,
    );
    assert.match(
      release,
      /key: ubrn-executable-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-rust-stable-0\.31\.0-5/,
    );
    assert.match(release, /steps\.ubrn_cache\.outputs\.cache-hit != 'true'/);
    assert.match(
      release,
      /name: Prepare UBRN generator[\s\S]*cargo \+stable build --manifest-path node_modules\/uniffi-bindgen-react-native\/crates\/ubrn_cli\/Cargo\.toml[\s\S]*name: Build Rust outputs/,
    );
    assert.doesNotMatch(release, /rustup toolchain install stable/);
    assert.match(release, /uses: dtolnay\/rust-toolchain@stable/);
    assert.match(release, /name: Setup Rust[\s\S]*?if: \$\{\{ matrix\.target\.os != 'win32' \}\}/);
    assert.match(release, /name: Verify preinstalled Windows Rust/);
    assert.match(release, /rustup target list --installed/);
    assert.match(release, /rust-lld\.exe/);
    assert.match(
      release,
      /CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER: \$\{\{ matrix\.target\.os == 'win32' && 'rust-lld' \|\| '' \}\}/,
    );
    assert.match(release, /CARGO_INCREMENTAL: "0"/);
    assert.match(release, /CARGO_TARGET_DIR: \$\{\{ github\.workspace \}\}\/target\/ubrn/);
    assert.match(release, /path: \.cache\/ubrn/);
    assert.match(release, /cp "target\/ubrn\/debug\/uniffi-bindgen-react-native/);
    assert.match(release, /--ubrn "\$UBRN_EXECUTABLE"/);
    assert.match(release, /name: Verify UBRN executable/);
    assert.match(release, /name: Save UBRN executable/);
    assert.match(release, /uses: actions\/cache\/save@v5/);
    assert.match(release, /key: \$\{\{ steps\.ubrn_cache\.outputs\.cache-primary-key \}\}/);
    assert.match(release, /name: Package release binaries/);
    assert.match(release, /name: fixture-databricks-auth-\$\{\{ matrix\.target\.node \}\}-npm/);
    assert.match(
      release,
      /name: fixture-databricks-auth-\$\{\{ matrix\.target\.python \}\}-python-wheel/,
    );
    assert.match(release, /name: fixture-tool-\$\{\{ matrix\.target\.node \}\}-binary/);
    assert.match(release, /Publish Python wheels/);
    assert.match(release, /name: pypi-fixture-databricks-auth/);
    assert.match(
      release,
      /cargo publish --package "fixture-databricks-auth" --registry crates-io --no-verify/,
    );
    assert.match(
      release,
      /cargo publish --package "fixture-tool" --registry crates-io --no-verify/,
    );
    const artifactPublisher = release.match(
      /^  publish-fixture-databricks-auth:[\s\S]*?(?=^  publish-cargo:)/m,
    )?.[0];
    assert.ok(artifactPublisher);
    assert.doesNotMatch(artifactPublisher, /Checkout|Setup Bun|bun install|Setup Rust/);
    assert.match(artifactPublisher, /Publish native npm packages[\s\S]*Publish npm facade/);
    const cargoPublisher = release.match(/^  publish-cargo:[\s\S]*?(?=^  publish-local-)/m)?.[0];
    assert.ok(cargoPublisher);
    assert.doesNotMatch(cargoPublisher, /Setup Bun|bun install|Setup sccache|libdbus/);
    const localPublishers = release.match(
      /^  publish-local-bindings:[\s\S]*?(?=^  publish-github-release:)/m,
    )?.[0];
    assert.ok(localPublishers);
    assert.doesNotMatch(localPublishers, /tasks\/publish-uniffi-local\.ts|bun install|Setup Bun/);
    assert.match(release, /^  publish-local-bindings:$/m);
    assert.match(release, /^  publish-local-cargo:$/m);
    assert.match(release, /LOCAL_CARGO_REGISTRY/);
    assert.match(release, /libdbus-1-dev pkg-config/);
    assert.match(release, /mozilla-actions\/sccache-action@v0\.0\.11/);
    assert.match(release, /Swatinem\/rust-cache@v2\.9\.2/);
    assert.match(release, /cache-targets: false/);
    assert.match(release, /add-job-id-key: false/);
    assert.match(release, /add-rust-environment-hash-key: false/);
    assert.match(release, /RUSTC_WRAPPER: sccache/);
    assert.equal(
      release.match(/shared-key: release-\$\{\{ matrix\.target\.cargo \}\}-rust-stable/g)?.length,
      1,
    );
    assert.match(
      release,
      /SCCACHE_GHA_VERSION: release-\$\{\{ matrix\.target\.cargo \}\}-rust-stable/,
    );
    assert.match(release, /cargo_cache_hit=/);
    assert.match(release, /ubrn_executable_cache_hit=/);
    assert.match(release, /"\$\{SCCACHE_PATH\}" --show-stats/);
    assert.match(release, /phase=rust_workspace duration_seconds=/);
    assert.doesNotMatch(release, /shared-key: cargo-publish/);
    assert.doesNotMatch(release, /^  build-binaries:$/m);
    assert.match(release, /fixture-tool-\$\{\{ matrix\.target\.node \}\}\.tar\.gz/);
    assert.match(release, /fixture-tool-\$\{\{ matrix\.target\.node \}\}\.zip/);
    assert.match(release, /name: Package release binaries/);
    assert.match(release, /7z a/);
    assert.match(release, /node: linux-x64-gnu/);
    assert.match(release, /^  publish-github-release:$/m);
    assert.match(release, /softprops\/action-gh-release@v2/);
    const packager = readFileSync(join(outdir, ".projen/uniffi-release.mjs"), "utf8");
    assert.match(packager, /#!\/usr\/bin\/env node/);
    assert.match(packager, /"target",\s+cargoTarget,\s+"release",\s+`\$\{crate\}-uniffi-bindgen/);
    assert.match(packager, /"node_modules", "npm", "bin", "npm-cli\.js"/);
    assert.match(packager, /command: process\.execPath, args: \[npmCli, \.\.\.args\]/);
    assert.match(packager, /"build",\s+"index\.ts",[\s\S]*?"--packages",\s+"external"/);
    assert.match(packager, /Object\.assign\(manifest, compiledPublish\)/);
    assert.match(packager, /manifest\.exports\["\."\]\.types = "\.\/index\.ts"/);
    assert.match(packager, /uniffi-facade-install-/);
    assert.match(packager, /facadePackage: singlePackage\(facadeOutput\)/);
    assert.match(
      packager,
      /run\("node", \["-e", `import\(\$\{JSON\.stringify\(nodePackage\)\}\)`\]/,
    );
    assert.match(
      packager,
      /parsed\.values\.ubrn \? \["--ubrn", parsed\.values\.ubrn, "--skip-barrels"\] : \[\]/,
    );
    assert.doesNotMatch(packager, /required\("ubrn"\)/);
    assert.match(packager, /if \(result\.error\) \{\s+throw new Error/);
    assert.doesNotMatch(packager, /"cargo",\s*\[\s*"run"/);
    const nodeGenerator = readFileSync(
      join(import.meta.dirname, "..", "tasks", "uniffi.ts"),
      "utf8",
    );
    assert.match(nodeGenerator, /values\.ubrn \? resolve\(values\.ubrn\)/);
    assert.match(nodeGenerator, /if \(!values\["skip-barrels"\]\)/);
    assert.equal(rust.pythonPackages.length, 1);
    assert.equal(
      readFileSync(join(outdir, "packages/js/node/databricks-auth/exports.ts"), "utf8"),
      'export * from "./src/bindings.ts";\n',
    );
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
