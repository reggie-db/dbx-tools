import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { PACKAGE_VERSION } from "../index.ts";
import { buildProgram } from "../src/cli.ts";
import {
  ensureRustReleaseBinary,
  runRustReleaseBinary,
  rustReleaseBinaryAsset,
  rustReleaseBinaryUrl,
  type RustReleaseBinaryCommand,
} from "../src/rust-binary.ts";

const COMMAND: RustReleaseBinaryCommand = {
  command: "fixture",
  description: "Run a fixture",
  binaryName: "fixture-bin",
  repository: "https://github.com/example/project",
  assets: [
    {
      os: "linux",
      cpu: "x64",
      name: "fixture-bin-linux-x64-gnu.tar.gz",
    },
  ],
};

describe("Rust release binaries", () => {
  it("registers generated commands without executing them", () => {
    const help = buildProgram().helpInformation();

    assert.match(help, /model-proxy/);
    assert.match(help, /lakebase-proxy/);
  });

  it("selects the generated platform archive and builds its release URL", () => {
    const asset = rustReleaseBinaryAsset(COMMAND, "linux", "x64");

    assert.equal(asset.name, "fixture-bin-linux-x64-gnu.tar.gz");
    assert.equal(
      rustReleaseBinaryUrl(COMMAND, asset, "1.2.3"),
      "https://github.com/example/project/releases/download/v1.2.3/fixture-bin-linux-x64-gnu.tar.gz",
    );
    assert.throws(
      () => rustReleaseBinaryAsset(COMMAND, "darwin", "arm64"),
      /no release binary for darwin\/arm64/,
    );
  });

  it("reuses an exact-version installation without resolving a download", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "dbx-rust-bin-"));
    const version = PACKAGE_VERSION.replace(/[^0-9A-Za-z]+/g, "_");
    const binDir = join(homeDir, ".dbx-tools", "bin");
    const path = join(binDir, `fixture-bin_${version}`);
    try {
      await mkdir(binDir, { recursive: true });
      await writeFile(
        path,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fixture-bin ${PACKAGE_VERSION}"; exit 0; fi\nexit 7\n`,
      );
      await chmod(path, 0o755);

      const installed = await ensureRustReleaseBinary(COMMAND, {
        homeDir,
        platform: "linux",
        arch: "x64",
      });
      assert.equal(installed.path, path);
      assert.equal(
        await runRustReleaseBinary(COMMAND, ["value"], {
          homeDir,
          platform: "linux",
          arch: "x64",
        }),
        7,
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
