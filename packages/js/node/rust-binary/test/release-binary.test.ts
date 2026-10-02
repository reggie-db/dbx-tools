import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { PACKAGE_VERSION } from "../index.ts";
import {
  ensureReleaseBinary,
  releaseBinaryCommand,
  releaseBinaryCommands,
  runReleaseBinary,
  releaseBinaryAsset,
  releaseBinaryUrl,
  type ReleaseBinaryCommand,
} from "../src/release-binary.ts";

const COMMAND: ReleaseBinaryCommand = {
  command: "fixture",
  description: "Run a fixture",
  binaryName: "fixture-bin",
  hidden: false,
  unit: "rs-fixture",
  component: "rs-fixture",
  version: PACKAGE_VERSION,
  tagPrefix: "rs-fixture-v",
  tag: `rs-fixture-v${PACKAGE_VERSION}`,
  repository: "https://github.com/example/project",
  crateName: "fixture-crate",
  cargoFeatures: ["desktop"],
  assets: [
    {
      os: "linux",
      cpu: "x64",
      name: "fixture-bin-linux-x64-gnu.tar.gz",
    },
  ],
};

interface PackageManifest {
  readonly name: string;
  readonly workspaces?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
}

function workspaceManifests(): ReadonlyMap<string, PackageManifest> {
  const root = resolve(import.meta.dirname, "../../../../..");
  const rootManifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as PackageManifest;
  return new Map(
    (rootManifest.workspaces ?? []).map((workspace) => {
      const manifest = JSON.parse(
        readFileSync(join(root, workspace, "package.json"), "utf8"),
      ) as PackageManifest;
      return [manifest.name, manifest] as const;
    }),
  );
}

function internalDependencyReach(
  manifests: ReadonlyMap<string, PackageManifest>,
  packageName: string,
): ReadonlySet<string> {
  const reachable = new Set<string>();
  const pending = [packageName];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const dependency of Object.keys(manifests.get(current)?.dependencies ?? {})) {
      if (!manifests.has(dependency) || reachable.has(dependency)) continue;
      reachable.add(dependency);
      pending.push(dependency);
    }
  }
  reachable.delete(packageName);
  return reachable;
}

describe("Rust release binaries", () => {
  it("keeps hidden auxiliary binaries available without exposing commands", () => {
    assert.equal(
      releaseBinaryCommands().some((command) => command.command === "model-proxy-tray"),
      false,
    );
    assert.equal(releaseBinaryCommand("model-proxy-tray").binaryName, "dbx-model-proxy-tray");
    assert.equal(releaseBinaryCommand("model-proxy").crateName, "dbx-tools-model-proxy");
    assert.deepEqual(releaseBinaryCommand("model-proxy").cargoFeatures, []);
    assert.equal(releaseBinaryCommand("lakebase-proxy").crateName, "dbx-tools-lakebase-proxy");
    assert.deepEqual(releaseBinaryCommand("model-proxy-tray").cargoFeatures, ["tray"]);
  });

  it("keeps the isolated runtime dependency reach below the CLI graph", () => {
    const manifests = workspaceManifests();
    const runtime = manifests.get("@dbx-tools/rust-binary");
    const runtimeReach = internalDependencyReach(manifests, "@dbx-tools/rust-binary");
    const cliReach = internalDependencyReach(manifests, "@dbx-tools/cli");

    assert.deepEqual(Object.keys(runtime?.dependencies ?? {}).sort(), [
      "@dbx-tools/core",
      "@dbx-tools/shared-core",
    ]);
    assert.deepEqual([...runtimeReach].sort(), [
      "@dbx-tools/core",
      "@dbx-tools/core-rs",
      "@dbx-tools/shared-core",
    ]);
    assert.ok(cliReach.size > runtimeReach.size);
    assert.equal(
      internalDependencyReach(manifests, "@dbx-tools/appkit-graphiti").has("@dbx-tools/cli"),
      false,
    );
  });

  it("selects the generated platform archive and builds its release URL", () => {
    const asset = releaseBinaryAsset(COMMAND, "linux", "x64");

    assert.equal(asset.name, "fixture-bin-linux-x64-gnu.tar.gz");
    assert.equal(
      releaseBinaryUrl(COMMAND, asset, "1.2.3"),
      "https://github.com/example/project/releases/download/rs-fixture-v1.2.3/fixture-bin-linux-x64-gnu.tar.gz",
    );
    assert.throws(
      () => releaseBinaryAsset(COMMAND, "darwin", "arm64"),
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

      const installed = await ensureReleaseBinary(COMMAND, {
        homeDir,
        platform: "linux",
        arch: "x64",
      });
      assert.equal(installed.path, path);
      assert.equal(
        await runReleaseBinary(COMMAND, ["value"], {
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

  it("reuses an unstamped 0.0.0 executable as the requested version", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "dbx-rust-bin-unstamped-"));
    const version = PACKAGE_VERSION.replace(/[^0-9A-Za-z]+/g, "_");
    const binDir = join(homeDir, ".dbx-tools", "bin");
    const path = join(binDir, `fixture-bin_${version}`);
    try {
      await mkdir(binDir, { recursive: true });
      await writeFile(
        path,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fixture-bin 0.0.0"; exit 0; fi\nexit 3\n`,
      );
      await chmod(path, 0o755);

      const installed = await ensureReleaseBinary(COMMAND, {
        homeDir,
        platform: "linux",
        arch: "x64",
      });
      assert.equal(installed.path, path);
      assert.equal(
        await runReleaseBinary(COMMAND, ["value"], {
          homeDir,
          platform: "linux",
          arch: "x64",
        }),
        3,
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it(
    "maps a binary signal exit to the conventional process code",
    { skip: process.platform === "win32" },
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), "dbx-rust-bin-signal-"));
      const version = PACKAGE_VERSION.replace(/[^0-9A-Za-z]+/g, "_");
      const binDir = join(homeDir, ".dbx-tools", "bin");
      const path = join(binDir, `fixture-bin_${version}`);
      try {
        await mkdir(binDir, { recursive: true });
        await writeFile(
          path,
          `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fixture-bin ${PACKAGE_VERSION}"; exit 0; fi\nkill -TERM $$\n`,
        );
        await chmod(path, 0o755);

        assert.equal(
          await runReleaseBinary(COMMAND, [], {
            homeDir,
            platform: "linux",
            arch: "x64",
          }),
          128 + osConstants.signals.SIGTERM,
        );
      } finally {
        await rm(homeDir, { recursive: true, force: true });
      }
    },
  );
});
