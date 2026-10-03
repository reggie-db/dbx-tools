import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  RustReleaseConfiguration,
  RustReleaseTargetPlan,
} from "../src/_rust-release-workflow.ts";
import { RustReleaseOs } from "../src/project-rs.ts";
import { localTargetCommand } from "../tasks/release-assets.ts";
import { resolveReleaseBuildMode } from "../tasks/release-pr.ts";

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

  it("uses local mode only for a prepared repository manager", () => {
    const base = {
      requested: "auto" as const,
      canManage: true,
      hasLocalTargets: true,
      localTools: [],
      approve: true,
      wait: true,
      hostPlatform: "darwin" as const,
    };
    assert.equal(resolveReleaseBuildMode(base), "local");
    assert.equal(resolveReleaseBuildMode({ ...base, canManage: false }), "remote");
    assert.equal(resolveReleaseBuildMode({ ...base, localTools: ["zig"] }), "remote");
    assert.equal(resolveReleaseBuildMode({ ...base, wait: false }), "remote");
    assert.throws(
      () => resolveReleaseBuildMode({ ...base, requested: "local", canManage: false }),
      /maintain or admin/,
    );
  });
});
