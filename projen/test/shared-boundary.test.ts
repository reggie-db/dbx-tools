import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";

interface Manifest {
  readonly name: string;
  readonly workspaces?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

it("keeps shared contract packages independent from Node, CLI, and UI packages", () => {
  const root = resolve(import.meta.dirname, "../..");
  const workspace = readJson<Manifest>(join(root, "package.json"));
  const manifests = (workspace.workspaces ?? []).map((path) => ({
    path,
    manifest: readJson<Manifest>(join(root, path, "package.json")),
  }));
  const forbidden = new Set(
    manifests
      .filter(({ path }) => /packages\/js\/(?:node|cli|ui)\//.test(path))
      .map(({ manifest }) => manifest.name),
  );

  for (const { path, manifest } of manifests.filter(({ path }) =>
    path.startsWith("packages/js/shared/"),
  )) {
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "devDependencies",
    ] as const) {
      const invalid = Object.keys(manifest[field] ?? {}).filter((name) => forbidden.has(name));
      assert.deepEqual(invalid, [], `${manifest.name} ${field}`);
    }

    const sourceRoot = join(root, path, "src");
    const pending = [sourceRoot];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(file);
        } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
          const source = readFileSync(file, "utf8");
          const imports = [
            ...source.matchAll(/(?:from\s+|import\s*\()(["'])(@dbx-tools\/[^"']+)\1/g),
          ]
            .map((match) => match[2]!)
            .filter((name) => forbidden.has(name));
          assert.deepEqual(imports, [], file);
        }
      }
    }
  }
});
