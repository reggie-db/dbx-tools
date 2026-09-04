/** Shared Bun setup and package-cache steps for generated workflows. */
import { TextFile, javascript } from "projen";

export const BUN_VERSION = "1.3.14";

const cacheKeyScript = `#!/usr/bin/env node
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
`;

const configured = new WeakSet<javascript.NodeProject>();

function ensureCacheKeyScript(project: javascript.NodeProject): void {
  if (configured.has(project)) return;
  new TextFile(project.root, ".projen/bun-cache-key.mjs", {
    lines: cacheKeyScript.trimEnd().split("\n"),
  });
  configured.add(project);
}

function stepCondition(condition: string | undefined, cacheMiss = false): string | undefined {
  const expressions = [
    condition,
    ...(cacheMiss ? ["steps.bun_cache.outputs.cache-hit != 'true'"] : []),
  ].filter(Boolean);
  return expressions.length ? `\${{ ${expressions.join(" && ")} }}` : undefined;
}

export interface BunWorkflowCacheOptions {
  readonly condition?: string;
}

/** Set up Bun and restore its global package cache. */
export function bunCacheRestoreSteps(
  project: javascript.NodeProject,
  options: BunWorkflowCacheOptions = {},
): readonly Record<string, unknown>[] {
  ensureCacheKeyScript(project);
  const condition = stepCondition(options.condition);
  return [
    {
      name: "Setup Bun",
      ...(condition ? { if: condition } : {}),
      uses: "oven-sh/setup-bun@v2",
      with: { "bun-version": "${{ env.BUN_VERSION }}" },
    },
    {
      name: "Resolve Bun cache",
      id: "bun_cache_metadata",
      ...(condition ? { if: condition } : {}),
      shell: "bash",
      run: [
        'echo "path=$(bun pm cache)" >> "$GITHUB_OUTPUT"',
        'echo "dependency_hash=$(node .projen/bun-cache-key.mjs)" >> "$GITHUB_OUTPUT"',
      ].join("\n"),
    },
    {
      name: "Restore Bun cache",
      id: "bun_cache",
      ...(condition ? { if: condition } : {}),
      uses: "actions/cache/restore@v5",
      with: {
        path: "${{ steps.bun_cache_metadata.outputs.path }}",
        key: `bun-\${{ runner.os }}-\${{ runner.arch }}-\${{ env.BUN_VERSION }}-\${{ steps.bun_cache_metadata.outputs.dependency_hash }}`,
        "restore-keys": `bun-\${{ runner.os }}-\${{ runner.arch }}-\${{ env.BUN_VERSION }}-`,
      },
    },
  ];
}

/** Save Bun's global package cache immediately after installation. */
export function bunCacheSaveStep(
  options: BunWorkflowCacheOptions = {},
): Readonly<Record<string, unknown>> {
  return {
    name: "Save Bun cache",
    if: stepCondition(options.condition, true),
    uses: "actions/cache/save@v5",
    with: {
      path: "${{ steps.bun_cache_metadata.outputs.path }}",
      key: "${{ steps.bun_cache.outputs.cache-primary-key }}",
    },
  };
}
