import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DBXToolsNodeProject, DBXToolsRustWorkspace } from "../src/project.ts";

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
      packages: {
        "auth-u2m": {
          dependencies: { uniffi: "0.31" },
          nodeDependencies: ["pg@^8"],
          nodeDevDependencies: ["@types/pg@^8"],
        },
        "auth-u2m-cli": {
          binaryName: "fixture-auth-u2m",
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
      environment: "native-fixture-auth-u2m",
      artifacts:
        "platform-specific wheels for linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64; all architectures publish to this one PyPI project",
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
    const release = readFileSync(join(outdir, ".github/workflows/rust-release.yml"), "utf8");
    assert.match(release, /fixture-auth-u2m/);
    assert.match(release, /linux-x64-gnu/);
    assert.match(release, /tasks\/uniffi-release\.ts build/);
    assert.match(release, /cargo publish --workspace --registry crates-io/);
    assert.match(release, /tasks\/publish-uniffi-local\.ts/);
    assert.match(release, /LOCAL_CARGO_REGISTRY/);
    assert.match(release, /libdbus-1-dev pkg-config/);
    assert.match(release, /^  build-binaries:$/m);
    assert.match(release, /binary: fixture-auth-u2m/);
    assert.match(release, /node: linux-x64-gnu/);
    assert.match(release, /^  publish-github-release:$/m);
    assert.match(release, /softprops\/action-gh-release@v2/);
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
      packages: { "private-cli": { private: true, binaryName: "private-cli" } },
    });
    project.synth();
    assert.match(
      readFileSync(join(project.outdir, "packages/rs/private-cli/Cargo.toml"), "utf8"),
      /^publish = false$/m,
    );
  });
});
