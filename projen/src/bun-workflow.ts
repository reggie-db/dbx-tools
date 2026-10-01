/** Shared Bun setup and package-cache steps for generated workflows. */
import { stringUtils } from "@dbx-tools/shared-core";
import { TextFile, javascript } from "projen";

export const BUN_VERSION = "1.3.14";

const DEFAULT_CACHE_IGNORE_PATHS = [
  ".git",
  ".venv",
  ".worktrees",
  "coverage",
  "dist",
  "lib",
  "node_modules",
  "target",
] as const;

function cacheKeyScript(extraIgnorePaths: readonly string[]): string {
  const ignorePaths = [...new Set(extraIgnorePaths)].sort();
  // prettier-ignore
  const source = (
    // ============================================================================
    /*js*/`
  #!/usr/bin/env node
  import { createHash } from "node:crypto";
  import { readdirSync, readFileSync } from "node:fs";
  import { join, sep } from "node:path";

  const root = process.cwd();
  const ignoredNames = new Set(${JSON.stringify(DEFAULT_CACHE_IGNORE_PATHS)});
  const ignoredPaths = new Set(${JSON.stringify(ignorePaths)});
  const manifests = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = path.slice(root.length + 1).split(sep).join("/");
      if (ignoredNames.has(entry.name) || ignoredPaths.has(relativePath)) continue;
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
  `
    // ============================================================================
  );
  return stringUtils.dedent(source, { trimEnd: false });
}

const configured = new WeakMap<javascript.NodeProject, string>();

function ensureCacheKeyScript(
  project: javascript.NodeProject,
  ignorePaths: readonly string[],
): void {
  const root = project.root as javascript.NodeProject;
  const key = JSON.stringify([...new Set(ignorePaths)].sort());
  const existing = configured.get(root);
  if (existing !== undefined) {
    if (existing !== key) {
      throw new Error("Bun workflow cache ignore paths must be consistent across one project");
    }
    return;
  }
  new TextFile(root, ".projen/bun-cache-key.mjs", {
    lines: cacheKeyScript(ignorePaths).trimEnd().split("\n"),
  });
  configured.set(root, key);
}

function stepCondition(condition: string | undefined, cacheMiss = false): string | undefined {
  const expressions = [
    condition,
    ...(cacheMiss ? ["steps.bun_cache.outputs.cache-hit != 'true'"] : []),
  ].filter(Boolean);
  return expressions.length ? `\${{ ${expressions.join(" && ")} }}` : undefined;
}

export interface BunWorkflowCacheOptions {
  readonly setupCondition?: string;
  readonly condition?: string;
  /** Repository-relative output paths excluded from dependency manifest hashing. */
  readonly ignorePaths?: readonly string[];
}

/** Set up Bun and restore its global package cache. */
export function bunCacheRestoreSteps(
  project: javascript.NodeProject,
  options: BunWorkflowCacheOptions = {},
): readonly Record<string, unknown>[] {
  ensureCacheKeyScript(project, options.ignorePaths ?? []);
  const condition = stepCondition(options.condition);
  const setupCondition = stepCondition(options.setupCondition);
  return [
    {
      name: "Setup Bun",
      ...(setupCondition ? { if: setupCondition } : {}),
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
