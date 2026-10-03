import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type {
  RustReleaseConfiguration,
  RustReleaseTargetPlan,
} from "../src/_rust-release-workflow.ts";
import { RustReleaseOs } from "../src/project-rs.ts";
import { localTargetCommand } from "../tasks/release-assets.ts";
import { verifyReleaseManifest, writeReleaseManifest } from "../tasks/release-manifest.ts";

const configuration: RustReleaseConfiguration = {
  releaseRustVersion: "stable",
  usesCargoLock: true,
  bindings: [],
  binaries: [],
  targets: [],
};

function target(os: RustReleaseOs, cargo: string, glibcVersion = ""): RustReleaseTargetPlan {
  return {
    runner: "fixture",
    cargo,
    node: "fixture",
    python: "fixture",
    os,
    cpu: "x64",
    libc: glibcVersion ? "glibc" : "",
    glibcVersion,
    packages: ["fixture-core", "fixture-tool"],
    binaries: ["fixture-tool"],
    features: ["fixture-core/uniffi-bindgen", "fixture-tool/tray"],
    localFeatures: [],
  };
}

describe("local Rust release assets", () => {
  it("selects native cross compilers without building tests", () => {
    const darwin = localTargetCommand(
      configuration,
      target(RustReleaseOs.DARWIN, "x86_64-apple-darwin"),
    );
    const linux = localTargetCommand(
      configuration,
      target(RustReleaseOs.LINUX, "x86_64-unknown-linux-gnu", "2.35"),
    );
    const windows = localTargetCommand(configuration, {
      ...target(RustReleaseOs.WINDOWS, "aarch64-pc-windows-msvc"),
      cpu: "arm64",
    });

    assert.equal(darwin.command, "cargo");
    assert.equal(darwin.args[0], "build");
    assert.deepEqual(linux.args.slice(0, 2), ["zigbuild", "--release"]);
    assert.ok(linux.args.includes("x86_64-unknown-linux-gnu.2.35"));
    assert.deepEqual(windows.args.slice(0, 2), ["xwin", "build"]);
    assert.equal(windows.args.includes("--cross-compiler"), false);
    for (const invocation of [darwin, linux, windows]) {
      assert.equal(invocation.args.includes("test"), false);
      assert.equal(invocation.args.includes("--tests"), false);
    }
  });

  it("binds exact candidate assets to the release tag and commit", () => {
    const directory = mkdtempSync(join(tmpdir(), "release-manifest-"));
    try {
      const npm = join(directory, "fixture-1.2.3.tgz");
      const wheel = join(directory, "fixture-1.2.3-py3-none-any.whl");
      writeFileSync(npm, "npm");
      writeFileSync(wheel, "python");
      const upload = join(directory, "upload");
      const manifest = writeReleaseManifest({
        artifacts: [
          {
            kind: "npm",
            packageName: "@fixture/core",
            packageVersion: "1.2.3",
            path: npm,
            role: "workspace",
          },
          {
            kind: "pypi",
            packageName: "fixture-core",
            packageVersion: "1.2.3",
            path: wheel,
            role: "workspace",
          },
        ],
        directory: upload,
        gitSha: "a".repeat(40),
        tag: "v1.2.3",
        version: "1.2.3",
      });
      assert.equal(manifest.artifacts.length, 2);
      assert.match(readFileSync(join(upload, "SHA256SUMS"), "utf8"), /fixture-1\.2\.3/);
      const selected = verifyReleaseManifest({
        directory: upload,
        gitSha: "a".repeat(40),
        kind: "npm",
        output: join(directory, "npm"),
        tag: "v1.2.3",
        version: "1.2.3",
      });
      assert.deepEqual(
        selected.map((artifact) => artifact.packageName),
        ["@fixture/core"],
      );
      assert.throws(
        () =>
          verifyReleaseManifest({
            directory: upload,
            gitSha: "different",
            tag: "v1.2.3",
            version: "1.2.3",
          }),
        /does not match/,
      );
      const manifestPath = join(upload, "release-manifest.json");
      const unsafe = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        artifacts: Array<{ name: string }>;
      };
      unsafe.artifacts[0]!.name = "../fixture-1.2.3.tgz";
      writeFileSync(manifestPath, `${JSON.stringify(unsafe)}\n`);
      assert.throws(
        () =>
          verifyReleaseManifest({
            directory: upload,
            gitSha: "a".repeat(40),
            tag: "v1.2.3",
            version: "1.2.3",
          }),
        /Invalid release artifact/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
