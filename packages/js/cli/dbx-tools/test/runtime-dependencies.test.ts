import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

interface PackageManifest {
  readonly name: string;
  readonly workspaces?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
}

const FORBIDDEN_RUNTIME_PACKAGES = new Set([
  "@dbx-tools/core-rs",
  "@dbx-tools/model-rs",
  "@dbx-tools/rust-binary",
]);

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

function dependencyReach(
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

describe("Node-owned model and Lakebase runtimes", () => {
  const manifests = workspaceManifests();

  for (const packageName of [
    "@dbx-tools/cli",
    "@dbx-tools/model",
    "@dbx-tools/cli-model-gateway",
    "@dbx-tools/appkit-graphiti",
    "@dbx-tools/appkit",
    "@dbx-tools/postgres",
    "@dbx-tools/lakebase",
    "@dbx-tools/cli-lakebase-proxy",
  ]) {
    it(`${packageName} cannot reach Rust runtime packages`, () => {
      const forbidden = [...dependencyReach(manifests, packageName)].filter((dependency) =>
        FORBIDDEN_RUNTIME_PACKAGES.has(dependency),
      );
      assert.deepEqual(forbidden, []);
    });
  }
});
