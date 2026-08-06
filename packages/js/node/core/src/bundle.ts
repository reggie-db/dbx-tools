/**
 * Streaming discovery of Databricks bundle App resources.
 *
 * Bundle files are found with native filesystem traversal inside a hard project
 * boundary. Each candidate is resolved through `databricks bundle validate
 * --output json` so includes, targets, variables, and App configuration follow
 * the Databricks CLI's semantics.
 *
 * @module
 */

import { opendir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { json, object, string } from "@dbx-tools/shared-core";
import { spawn } from "./exec.ts";
import { resolveWorkingDirectory } from "./project.ts";
import { project } from "../index.ts";

const BUNDLE_FILE_NAMES = new Set(["databricks.yml", "databricks.yaml"]);
const IGNORED_DIRECTORIES = [
  /^\..*/,
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "tmp",
  "vendor",
] as const;

type AppResource = {
  /** Absolute path to the bundle's root configuration file. */
  bundlePath: string;
  /** Resource key under `resources.apps`. */
  key: string;
  /** Absolute source directory resolved from `source_code_path`. */
  sourceCodePath?: string;
  /** App resource returned by `databricks bundle validate`. */
  config: Record<string, unknown>;
  /** Complete resolved bundle returned by `databricks bundle validate`. */
  data: Record<string, unknown>;
  /** Validation failure associated with partial bundle output. */
  bundleFailure?: Error;
};

/**
 * Stream every App resource in bundles under `projectBoundary`.
 *
 * `cwd` defaults to the current directory and may name a file or directory.
 * Bundle files in its ancestor chain are checked before the rest of the project
 * boundary. No App YAML file is required.
 *
 * A missing or invalid boundary/cwd, or a cwd outside the boundary, yields
 * nothing. A non-zero validation with partial JSON attaches
 * `bundleFailure` to each App resource parsed from that bundle. A failed
 * validation with no App resources yields nothing.
 */
export async function* appResources(
  projectBoundary: string,
  cwd?: string,
): AsyncGenerator<AppResource, void, void> {
  const boundary = await resolveDirectory(projectBoundary);
  const startDirectory = await resolveStartDirectory(cwd);
  if (!boundary || !startDirectory || !isWithinOrEqual(startDirectory, boundary)) {
    return;
  }

  for await (const bundlePath of bundlePaths(boundary, startDirectory)) {
    const validated = await validateBundle(bundlePath);
    for (const [key, config] of Object.entries(bundleApps(validated.data))) {
      if (!object.isRecord(config)) continue;
      yield {
        bundlePath,
        key,
        config,
        data: validated.data,
        ...object.optional(
          "sourceCodePath",
          resolveSourceCodePath(bundlePath, config.source_code_path),
        ),
        ...object.optional("bundleFailure", validated.bundleFailure),
      };
    }
  }
}

async function resolveDirectory(value: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(resolve(value));
    return (await stat(resolved)).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

async function resolveStartDirectory(cwd?: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(resolveWorkingDirectory(cwd));
    const info = await stat(resolved);
    if (info.isDirectory()) return resolved;
    if (info.isFile()) return dirname(resolved);
    return undefined;
  } catch {
    return undefined;
  }
}

function resolveSourceCodePath(bundlePath: string, sourceCodePath: unknown): string | undefined {
  if (typeof sourceCodePath !== "string") return undefined;
  return isAbsolute(sourceCodePath) ? sourceCodePath : resolve(dirname(bundlePath), sourceCodePath);
}

async function* bundlePaths(
  boundary: string,
  startDirectory: string,
): AsyncGenerator<string, void, void> {
  const seen = new Set<string>();
  let current = startDirectory;
  while (isWithinOrEqual(current, boundary)) {
    for (const filename of BUNDLE_FILE_NAMES) {
      const candidate = join(current, filename);
      if (!(await isFile(candidate))) continue;
      const resolved = await realpath(candidate);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      yield resolved;
    }
    if (current === boundary) break;
    current = dirname(current);
  }

  yield* descendBundlePaths(boundary, seen);
}

async function* descendBundlePaths(
  directory: string,
  seen: Set<string>,
): AsyncGenerator<string, void, void> {
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const candidate = join(directory, entry.name);
    if (entry.isDirectory()) {
      const ignored = IGNORED_DIRECTORIES.some((ignore) => {
        if (ignore instanceof RegExp) return ignore.test(entry.name);
        return ignore === entry.name;
      });
      if (!ignored) {
        yield* descendBundlePaths(candidate, seen);
      }
      continue;
    }
    if (!entry.isFile() || !BUNDLE_FILE_NAMES.has(entry.name)) continue;
    const resolved = await realpath(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    yield resolved;
  }
}

async function validateBundle(
  bundlePath: string,
): Promise<Pick<AppResource, "data" | "bundleFailure">> {
  const result = await spawn("databricks", ["bundle", "validate", "--output", "json"], {
    cwd: dirname(bundlePath),
    stdin: "ignore",
    stdout: "capture",
    stderr: "capture",
  });
  const detail = string.trimToNull(result.stderr) ?? string.trimToNull(result.stdout);
  const bundleFailure =
    result.exitCode === 0
      ? undefined
      : new Error(
          `databricks bundle validate failed for ${bundlePath} (exit ${result.exitCode})${
            detail ? `: ${detail}` : ""
          }`,
        );

  const parsed = json.parseRecord(result.stdout);
  if (!parsed) {
    if (bundleFailure) return { data: {}, bundleFailure };
    throw new Error(`Databricks CLI returned invalid bundle JSON for ${bundlePath}`);
  }
  return { data: parsed, ...object.optional("bundleFailure", bundleFailure) };
}

function bundleApps(bundle: Record<string, unknown>): Record<string, unknown> {
  const resources = object.isRecord(bundle.resources) ? bundle.resources : undefined;
  return object.isRecord(resources?.apps) ? resources.apps : {};
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isWithinOrEqual(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: bun bundle.ts <path>");
  for await (const resource of appResources(project.root()!, path)) {
    console.dir(resource, { depth: null });
  }
}
