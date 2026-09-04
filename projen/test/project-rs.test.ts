import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  DBXToolsNodeProject,
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
      new DBXToolsRustWorkspace(project, { scope: "fixture" });
      project.synth();
      assert.equal(existsSync(join(emptyOutdir, ".github/workflows/rust-release.yml")), false);
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
        scope: "fixture",
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
      const cargoJob = release.match(/^  publish-cargo:[\s\S]*?(?=^  publish-local:)/m)?.[0];
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
        scope: "fixture",
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
      scope: "fixture",
      repository: "https://example.invalid/fixture",
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
        },
      ],
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
    const release = readFileSync(join(outdir, ".github/workflows/rust-release.yml"), "utf8");
    assert.match(release, /fixture-auth-u2m/);
    assert.match(release, /linux-x64-gnu/);
    assert.match(release, /darwin-arm64/);
    assert.doesNotMatch(release, /linux-arm64-gnu/);
    assert.doesNotMatch(release, /darwin-x64/);
    assert.doesNotMatch(release, /win32-x64-msvc/);
    assert.equal(release.match(/^          - target:$/gm)?.length, 2);
    assert.doesNotMatch(release, /^  build-binaries:$/m);
    assert.match(release, /cargo build --release --workspace --target/);
    assert.match(release, /node \.projen\/uniffi-release\.mjs build/);
    assert.match(release, /--skip-build/);
    assert.match(release, /name: Cache UBRN generator/);
    assert.match(release, /key: ubrn-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-0\.31\.0-5/);
    assert.match(
      release,
      /name: Prepare UBRN generator[\s\S]*node_modules\/uniffi-bindgen-react-native\/crates\/ubrn_cli\/Cargo\.toml[\s\S]*name: Build Rust outputs/,
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
    const cargoPublisher = release.match(/^  publish-cargo:[\s\S]*?(?=^  publish-local:)/m)?.[0];
    assert.ok(cargoPublisher);
    assert.doesNotMatch(cargoPublisher, /Setup Bun|bun install|Setup sccache|libdbus/);
    assert.match(release, /tasks\/publish-uniffi-local\.ts/);
    assert.match(release, /LOCAL_CARGO_REGISTRY/);
    assert.match(release, /libdbus-1-dev pkg-config/);
    assert.match(release, /mozilla-actions\/sccache-action@v0\.0\.11/);
    assert.match(release, /Swatinem\/rust-cache@v2\.9\.2/);
    assert.match(release, /cache-targets: false/);
    assert.match(release, /add-job-id-key: false/);
    assert.match(release, /add-rust-environment-hash-key: false/);
    assert.match(release, /RUSTC_WRAPPER: sccache/);
    assert.equal(
      release.match(/shared-key: release-\$\{\{ matrix\.target\.cargo \}\}/g)?.length,
      1,
    );
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
