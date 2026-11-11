/** Workspace dependency and test selection used by generated Projen tasks. */
import { writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "@dbx-tools/core";
import { findFilesSync } from "@dbx-tools/path";
import { log, sequence } from "@dbx-tools/shared-core";
import { recordedPackages, toPosix, workspaceDependencyNames } from "./packages.ts";

const logger = log.logger("projen:test");
const PROJEN_INTEGRATION_TEST =
  /(?:local-publish|npm-release|packed-consumer|project-py|publish|python-sync|release|root-install|sdk-boundary).*\.test\.ts$/;

/** One recorded workspace package and its internal dependency edges. */
export interface WorkspaceGraphPackage {
  /** Published package name. */
  readonly name: string;
  /** Repository-relative package directory. */
  readonly path: string;
  /** Direct internal workspace dependencies. */
  readonly dependencies: readonly string[];
  /** Workspace packages that directly depend on this package. */
  readonly reverseDependencies: readonly string[];
}

/** Generated package dependency graph used for local test selection. */
export interface WorkspaceGraph {
  /** Recorded workspace packages sorted by package name. */
  readonly packages: readonly WorkspaceGraphPackage[];
}

/** Runtime workspace diagnostic or test-selection mode. */
export type DynamicTestMode = "focused" | "changed" | "graph";

/** Build the workspace and reverse-dependency graph from recorded package manifests. */
export function workspaceGraph(root: string): WorkspaceGraph {
  const packages = new Map<string, { path: string; manifest: Readonly<Record<string, unknown>> }>();
  for (const pkg of recordedPackages(root)) {
    if (pkg.name && pkg.manifest) {
      packages.set(pkg.name, { path: pkg.path, manifest: pkg.manifest });
    }
  }
  const reverse = new Map<string, Set<string>>();
  const rows = [...packages].map(([name, pkg]) => {
    const dependencies = new Set<string>();
    for (const dependency of workspaceDependencyNames(pkg.manifest, { includeDev: true })) {
      if (!packages.has(dependency)) continue;
      dependencies.add(dependency);
      const dependents = reverse.get(dependency) ?? new Set<string>();
      dependents.add(name);
      reverse.set(dependency, dependents);
    }
    return { name, path: pkg.path, dependencies: [...dependencies].sort() };
  });
  return {
    packages: rows
      .map((pkg) => ({
        ...pkg,
        reverseDependencies: [...(reverse.get(pkg.name) ?? [])].sort(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/** Write the generated workspace graph consumed by diagnostics and local tooling. */
export function writeWorkspaceGraph(root: string, graph: WorkspaceGraph): void {
  const path = join(root, ".projen", "workspace-graph.json");
  writeFileSync(path, `${JSON.stringify(graph, null, 2)}\n`);
  logger.info(`wrote ${relative(root, path)}`);
}

function testFiles(directory: string): string[] {
  return [
    ...findFilesSync("**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}", {
      cwd: directory,
      absolute: true,
      nodir: true,
      ignoreOptions: { test: false },
    }),
  ].sort();
}

/** True when a test belongs to the explicit integration tier. */
export function isIntegrationTest(path: string): boolean {
  return (
    path.includes(".integration.test.") ||
    (toPosix(path).includes("/projen/test/") && PROJEN_INTEGRATION_TEST.test(basename(path)))
  );
}

/** Every JavaScript and TypeScript test owned by the workspace. */
export function workspaceTestFiles(root: string, graph = workspaceGraph(root)): string[] {
  return [
    ...graph.packages.flatMap((pkg) => testFiles(join(root, pkg.path, "test"))),
    ...testFiles(join(root, "test")),
    ...testFiles(join(root, "scripts")),
    ...testFiles(join(root, "docs/scripts")),
  ];
}

function packageForPath(
  packagesByPath: readonly WorkspaceGraphPackage[],
  path: string,
): WorkspaceGraphPackage | undefined {
  const normalized = toPosix(path);
  return packagesByPath.find(
    (pkg) => normalized === pkg.path || normalized.startsWith(`${pkg.path}/`),
  );
}

function affectedPackages(graph: WorkspaceGraph, changed: readonly string[]): Set<string> | "all" {
  const byName = new Map(graph.packages.map((pkg) => [pkg.name, pkg]));
  const byPath = [...graph.packages].sort((left, right) => right.path.length - left.path.length);
  const affected = new Set<string>();
  const pending: string[] = [];
  for (const path of changed) {
    const pkg = packageForPath(byPath, path);
    if (!pkg) return "all";
    if (!affected.has(pkg.name)) pending.push(pkg.name);
  }
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (affected.has(name)) continue;
    affected.add(name);
    pending.push(...(byName.get(name)?.reverseDependencies ?? []));
  }
  return affected;
}

function changedFiles(root: string, base?: string): string[] {
  const candidates = base ? [base] : ["origin/main", "main", "HEAD~1"];
  let committed: string[] = [];
  for (const candidate of candidates) {
    const result = spawnSync("git", ["diff", "--name-only", `${candidate}...HEAD`], {
      cwd: root,
      stdin: "ignore",
      stdout: "capture",
      stderr: "ignore",
    });
    if (result.exitCode === 0) {
      committed = result.stdoutLines.filter(Boolean);
      break;
    }
  }
  const working = spawnSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: root,
    stdin: "ignore",
    stdout: "capture",
    stderr: "ignore",
    check: true,
  }).stdoutLines;
  return [...sequence(committed, working).filter(Boolean).distinct()].sort();
}

/** Select tests for dependency-aware local modes whose inputs cannot be generated. */
export function selectWorkspaceTests(
  root: string,
  graph: WorkspaceGraph,
  mode: Exclude<DynamicTestMode, "graph">,
  selections: readonly string[],
  base?: string,
): string[] {
  const all = workspaceTestFiles(root, graph);
  let names: Set<string> | "all";
  if (mode === "changed") {
    const changed = changedFiles(root, base);
    if (changed.length === 0) return [];
    names = affectedPackages(graph, changed);
  } else {
    if (selections.length === 0) throw new Error("test:focused requires a package name or path");
    names = new Set<string>();
    const packagesByPath = [...graph.packages].sort(
      (left, right) => right.path.length - left.path.length,
    );
    for (const value of selections) {
      const direct = graph.packages.find((pkg) => pkg.name === value);
      const byPath =
        direct ?? packageForPath(packagesByPath, toPosix(relative(root, resolve(root, value))));
      if (!byPath) throw new Error(`Unknown workspace package or path: ${value}`);
      names.add(byPath.name);
    }
  }
  if (names === "all") return all;
  const paths = new Set(graph.packages.filter((pkg) => names.has(pkg.name)).map((pkg) => pkg.path));
  return all.filter((path) => {
    const relativePath = toPosix(relative(root, path));
    return [...paths].some((pkg) => relativePath.startsWith(`${pkg}/`));
  });
}

function runnerGroup(root: string, path: string): string {
  const relativePath = toPosix(relative(root, path));
  if (relativePath.startsWith("packages/js/shared/")) return "browser-shared";
  if (
    relativePath.startsWith("packages/js/ui/") ||
    relativePath.startsWith("packages/demo/client/")
  ) {
    return "react-ui";
  }
  if (relativePath.startsWith("projen/")) return "projen";
  if (relativePath.startsWith("docs/scripts/")) return "docs";
  if (relativePath.startsWith("packages/demo/")) return "demo";
  return "node";
}

/** Run selected tests in the established root runner groups. */
export async function runWorkspaceTests(root: string, files: readonly string[]): Promise<void> {
  if (files.length === 0) {
    logger.info("no tests selected");
    return;
  }
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const name = runnerGroup(root, file);
    const paths = groups.get(name) ?? [];
    paths.push(relative(root, file));
    groups.set(name, paths);
  }
  const results = await Promise.all(
    [...groups].map(async ([name, paths]) => ({
      name,
      result: await spawn("bun", ["test", ...paths], {
        cwd: root,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      }),
    })),
  );
  const failed = results.filter(({ result }) => result.exitCode !== 0);
  if (failed.length > 0) {
    throw new Error(`Test groups failed: ${failed.map(({ name }) => name).join(", ")}`);
  }
}
