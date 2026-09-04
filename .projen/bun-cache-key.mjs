#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const ignored = new Set([
  ".git",
  ".docs-build",
  ".venv",
  ".worktrees",
  "coverage",
  "dist",
  "lib",
  "node_modules",
  "target",
]);
const manifests = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name === "package.json") manifests.push(path);
  }
};
walk(root);

const dependencyFields = [
  "catalog",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "overrides",
  "peerDependencies",
  "peerDependenciesMeta",
  "resolutions",
  "trustedDependencies",
];
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
};
const dependencies = manifests
  .sort()
  .map((path) => {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    return [
      path.slice(root.length + 1),
      Object.fromEntries(
        dependencyFields
          .filter((field) => manifest[field] !== undefined)
          .map((field) => [field, canonical(manifest[field])]),
      ),
    ];
  });
process.stdout.write(createHash("sha256").update(JSON.stringify(dependencies)).digest("hex"));