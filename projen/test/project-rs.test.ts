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
  mkdirSync(join(outdir, "packages/rs/auth-u2m/src"), { recursive: true });
  writeFileSync(
    join(outdir, "packages/rs/auth-u2m/src/lib.rs"),
    "pub fn value() {}\nuniffi::setup_scaffolding!();\n",
  );
  mkdirSync(join(outdir, "packages/rs/auth-u2m-cli/src"), { recursive: true });
  writeFileSync(join(outdir, "packages/rs/auth-u2m-cli/src/main.rs"), "fn main() {}\n");
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
      assert.equal(
        existsSync(join(emptyOutdir, ".github/workflows/rust-release-dispatch.yml")),
        false,
      );
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
      assert.match(pythonRelease, /workflows:\s+- rust-release/);
      assert.match(nodeRelease, /workflows:\s+- python-release/);
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
        "auth-u2m": {
          dependencies: { uniffi: "0.31" },
          nodeDependencies: ["pg@^8"],
          nodeDevDependencies: ["@types/pg@^8"],
        },
        "auth-u2m-cli": {
          release: true,
        },
      },
    });
    project.synth();

    assert.equal(rust.packages[0]?.crateName, "fixture-auth-u2m");
    assert.equal(rust.pythonPackages.length, 1);
    assert.equal(rust.pythonPackages[0]?.name, "fixture-auth-u2m");
    assert.equal(rust.pythonPackages[0]?.module, "fixture.auth_u2m");
    assert.equal(rust.pythonPackages[0]?.private, true);
    assert.deepEqual(rust.pythonPackages[0]?.generatedSources, [
      "src/fixture/auth_u2m/bindings.py",
    ]);
    assert.deepEqual(rust.pythonPackages[0]?.trustedPublisher, {
      workflowName: "rust-release",
      environment: "pypi-fixture-auth-u2m",
      artifacts:
        "platform-specific wheels for darwin-arm64, linux-x64; all architectures publish to this one PyPI project",
    });
    assert.deepEqual(rust.workspaceMapping, {
      root: "packages/rs",
      crates: ["packages/rs/auth-u2m", "packages/rs/auth-u2m-cli"],
      bindings: [
        {
          crate: "fixture-auth-u2m",
          rust: "packages/rs/auth-u2m",
          node: "packages/js/node/auth-u2m",
          nodePackage: "@fixture/auth-u2m",
          python: "packages/py/auth-u2m",
          pythonPackage: "fixture-auth-u2m",
          pythonModule: "fixture.auth_u2m",
        },
      ],
      releaseWorkflow: "rust-release",
    });
    assert.deepEqual(project.dbxToolsConfig.rust, rust.workspaceMapping);
    assert.match(
      readFileSync(join(outdir, "packages/rs/auth-u2m/Cargo.toml"), "utf8"),
      /crate-type = \["lib", "cdylib"\]/,
    );
    const node = JSON.parse(
      readFileSync(join(outdir, "packages/js/node/auth-u2m/package.json"), "utf8"),
    ) as {
      name: string;
      private: boolean;
      dependencies: object;
      devDependencies: object;
      optionalDependencies: object;
    };
    assert.equal(node.name, "@fixture/auth-u2m");
    assert.equal(node.private, true);
    assert.equal("pg" in node.dependencies, true);
    assert.equal("@types/pg" in node.devDependencies, true);
    assert.equal("@fixture/auth-u2m-darwin-arm64" in node.optionalDependencies, true);
    assert.equal("@fixture/auth-u2m-linux-x64-gnu" in node.optionalDependencies, true);
    assert.equal("@fixture/auth-u2m-darwin-x64" in node.optionalDependencies, false);
    const gitignore = readFileSync(join(outdir, ".gitignore"), "utf8");
    assert.match(gitignore, /^target\/$/m);
    assert.match(gitignore, /^packages\/js\/node\/auth-u2m\/src\/bindings\.ts$/m);
    assert.match(gitignore, /^packages\/py\/auth-u2m\/src\/fixture\/auth_u2m\/bindings\.py$/m);
    const release = readFileSync(join(outdir, ".github/workflows/rust-release.yml"), "utf8");
    const dispatcher = readFileSync(
      join(outdir, ".github/workflows/rust-release-dispatch.yml"),
      "utf8",
    );
    assert.match(dispatcher, /^  push:\n    tags:\n      - v\*$/m);
    assert.match(dispatcher, /EXPECTED_SHA="\$\(git rev-parse "\$RELEASE_TAG\^\{commit\}"\)"/);
    assert.match(dispatcher, /gh api --method POST "repos\/\$GITHUB_REPOSITORY\/dispatches"/);
    assert.match(dispatcher, /--raw-field event_type="\$RELEASE_EVENT"/);
    assert.match(dispatcher, /client_payload\[release_tag\]=\$RELEASE_TAG/);
    assert.match(dispatcher, /client_payload\[expected_sha\]=\$EXPECTED_SHA/);
    assert.doesNotMatch(dispatcher, /actions\/cache|cargo build|sccache/);
    assert.match(release, /^  repository_dispatch:\n    types:\n      - rust-release$/m);
    assert.match(release, /^  workflow_dispatch:$/m);
    assert.doesNotMatch(release, /^  push:$/m);
    assert.match(release, /github\.event\.client_payload\.expected_sha \|\| inputs\.expected_sha/);
    assert.match(
      release,
      /test "\$\(git rev-parse "\$RELEASE_TAG\^\{commit\}"\)" = "\$EXPECTED_SHA"/,
    );
    assert.match(release, /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/);
    assert.match(release, /fixture-auth-u2m/);
    assert.match(release, /linux-x64-gnu/);
    assert.match(release, /darwin-arm64/);
    assert.doesNotMatch(release, /linux-arm64-gnu/);
    assert.doesNotMatch(release, /darwin-x64/);
    assert.doesNotMatch(release, /win32-x64-msvc/);
    assert.match(
      readFileSync(join(outdir, ".github/workflows/node-release.yml"), "utf8"),
      /workflows:\s+- rust-release/,
    );
    assert.equal(release.match(/^          - target:$/gm)?.length, 2);
    assert.doesNotMatch(release, /^  build-binaries:$/m);
    assert.match(release, /cargo build --release --workspace --target/);
    assert.match(release, /node \.projen\/uniffi-release\.mjs build/);
    assert.match(release, /--skip-build/);
    assert.match(release, /name: Cache UBRN generator/);
    assert.match(
      release,
      /key: ubrn-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-rust-stable-0\.31\.0-5/,
    );
    assert.match(release, /if: \$\{\{ vars\.CACHE_UBRN_TARGET == 'true' \}\}/);
    assert.match(
      release,
      /name: Prepare UBRN generator[\s\S]*rustup toolchain install stable --profile minimal[\s\S]*cargo \+stable build --manifest-path node_modules\/uniffi-bindgen-react-native\/crates\/ubrn_cli\/Cargo\.toml[\s\S]*name: Build Rust outputs/,
    );
    assert.match(release, /CARGO_TARGET_DIR: \$\{\{ github\.workspace \}\}\/target\/ubrn/);
    assert.match(release, /name: Package release binaries/);
    assert.match(release, /name: fixture-auth-u2m-\$\{\{ matrix\.target\.node \}\}-npm/);
    assert.match(release, /name: fixture-auth-u2m-\$\{\{ matrix\.target\.python \}\}-python-wheel/);
    assert.match(release, /name: fixture-auth-u2m-cli-\$\{\{ matrix\.target\.node \}\}-binary/);
    assert.match(release, /Publish Python wheels/);
    assert.match(release, /name: pypi-fixture-auth-u2m/);
    assert.match(
      release,
      /cargo publish --package "fixture-auth-u2m" --registry crates-io --no-verify/,
    );
    assert.match(
      release,
      /cargo publish --package "fixture-auth-u2m-cli" --registry crates-io --no-verify/,
    );
    const artifactPublisher = release.match(
      /^  publish-fixture-auth-u2m:[\s\S]*?(?=^  publish-cargo:)/m,
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
      release.match(/shared-key: release-\$\{\{ matrix\.target\.cargo \}\}-rust-1\.82/g)?.length,
      1,
    );
    assert.match(
      release,
      /SCCACHE_GHA_VERSION: release-\$\{\{ matrix\.target\.cargo \}\}-rust-1\.82/,
    );
    assert.match(release, /cargo_cache_hit=/);
    assert.match(release, /ubrn_target_cache_hit=/);
    assert.match(release, /"\$\{SCCACHE_PATH\}" --show-stats/);
    assert.match(release, /phase=rust_workspace duration_seconds=/);
    assert.doesNotMatch(release, /shared-key: cargo-publish/);
    assert.doesNotMatch(release, /^  build-binaries:$/m);
    assert.match(release, /fixture-auth-u2m-cli-\$\{\{ matrix\.target\.node \}\}\.tar\.gz/);
    assert.match(release, /fixture-auth-u2m-cli-\$\{\{ matrix\.target\.node \}\}\.zip/);
    assert.match(release, /name: Package release binaries/);
    assert.match(release, /7z a/);
    assert.match(release, /node: linux-x64-gnu/);
    assert.match(release, /^  publish-github-release:$/m);
    assert.match(release, /softprops\/action-gh-release@v2/);
    const packager = readFileSync(join(outdir, ".projen/uniffi-release.mjs"), "utf8");
    assert.match(packager, /#!\/usr\/bin\/env node/);
    assert.match(packager, /"target",\s+cargoTarget,\s+"release",\s+`uniffi-bindgen/);
    assert.doesNotMatch(packager, /"cargo",\s*\[\s*"run"/);
    assert.equal(rust.pythonPackages.length, 1);
    assert.equal(
      readFileSync(join(outdir, "packages/js/node/auth-u2m/exports.ts"), "utf8"),
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
