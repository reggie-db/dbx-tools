import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

interface PackageManifest {
  readonly name?: string;
  readonly workspaces?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

/** Deliberate non-exact internal dependencies, keyed by package, field, and dependency. */
const INTERNAL_DEPENDENCY_EXCEPTIONS = new Map<string, string>();

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

it("uses exact workspace versions for every internal dependency", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const rootManifest = readManifest(resolve(root, "package.json"));
  const manifests = [
    [".", rootManifest] as const,
    ...(rootManifest.workspaces ?? []).map(
      (workspace) => [workspace, readManifest(resolve(root, workspace, "package.json"))] as const,
    ),
  ];
  const usedExceptions = new Set<string>();

  for (const [workspace, manifest] of manifests) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependency, version] of Object.entries(manifest[field] ?? {})) {
        if (!dependency.startsWith("@dbx-tools/")) continue;
        const key = `${manifest.name ?? workspace}:${field}:${dependency}`;
        if (INTERNAL_DEPENDENCY_EXCEPTIONS.has(key)) {
          usedExceptions.add(key);
          continue;
        }
        assert.equal(version, "workspace:*", `${key} must use workspace:*`);
      }
    }
  }

  assert.deepEqual(
    [...usedExceptions].sort(),
    [...INTERNAL_DEPENDENCY_EXCEPTIONS.keys()].sort(),
    "internal dependency exception entries must match a generated manifest dependency",
  );
});
