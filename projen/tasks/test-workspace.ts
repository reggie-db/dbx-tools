import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import * as exec from "@dbx-tools/core/exec";
import { log, object } from "@dbx-tools/shared-core";

const logger = log.logger("projen:test");

interface PackageManifest {
  readonly name?: string;
  readonly workspaces?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

export interface WorkspaceGraphPackage {
  readonly name: string;
  readonly path: string;
  readonly dependencies: readonly string[];
  readonly reverseDependencies: readonly string[];
}

export interface WorkspaceGraph {
  readonly packages: readonly WorkspaceGraphPackage[];
}

type TestMode = "focused" | "changed" | "unit" | "integration" | "all" | "graph";

const PROJEN_INTEGRATION_TEST =
  /(?:local-publish|npm-release|packed-consumer|project-py|publish|python-sync|release|root-install|sdk-boundary).*\.test\.ts$/;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export function workspaceGraph(root: string): WorkspaceGraph {
  const workspace = readJson<PackageManifest>(join(root, "package.json"));
  const packages = new Map<string, { path: string; manifest: PackageManifest }>();
  for (const member of workspace.workspaces ?? []) {
    const manifest = readJson<PackageManifest>(join(root, member, "package.json"));
    if (manifest.name) packages.set(manifest.name, { path: toPosix(member), manifest });
  }
  const reverse = new Map<string, Set<string>>();
  const rows = [...packages].map(([name, pkg]) => {
    const dependencies = new Set<string>();
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "devDependencies",
    ] as const) {
      for (const dependency of Object.keys(pkg.manifest[field] ?? {})) {
        if (!packages.has(dependency)) continue;
        dependencies.add(dependency);
        const dependents = reverse.get(dependency) ?? new Set<string>();
        dependents.add(name);
        reverse.set(dependency, dependents);
      }
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

function writeGraph(root: string, graph: WorkspaceGraph): void {
  const path = join(root, ".projen", "workspace-graph.json");
  writeFileSync(path, `${JSON.stringify(graph, null, 2)}\n`);
  logger.info(`wrote ${relative(root, path)}`);
}

function testFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:test|spec)\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  visit(directory);
  return files.sort();
}

function integrationTest(path: string): boolean {
  return (
    path.includes(".integration.test.") ||
    (toPosix(path).includes("/projen/test/") && PROJEN_INTEGRATION_TEST.test(basename(path)))
  );
}

function packageForPath(graph: WorkspaceGraph, path: string): WorkspaceGraphPackage | undefined {
  const normalized = toPosix(path);
  return [...graph.packages]
    .sort((left, right) => right.path.length - left.path.length)
    .find((pkg) => normalized === pkg.path || normalized.startsWith(`${pkg.path}/`));
}

function affectedPackages(graph: WorkspaceGraph, changed: readonly string[]): Set<string> {
  const byName = new Map(graph.packages.map((pkg) => [pkg.name, pkg]));
  const affected = new Set<string>();
  const pending: string[] = [];
  for (const path of changed) {
    const pkg = packageForPath(graph, path);
    if (!pkg) return new Set(graph.packages.map((entry) => entry.name));
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
    const result = exec.spawnSync("git", ["diff", "--name-only", `${candidate}...HEAD`], {
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
  const working = exec.spawnSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: root,
    stdin: "ignore",
    stdout: "capture",
    stderr: "ignore",
    check: true,
  }).stdoutLines;
  return [...object.sequence(committed, working).filter(Boolean).distinct()].sort();
}

function selectedTests(
  root: string,
  graph: WorkspaceGraph,
  mode: TestMode,
  args: readonly string[],
): string[] {
  const all = [
    ...graph.packages.flatMap((pkg) => testFiles(join(root, pkg.path, "test"))),
    ...testFiles(join(root, "docs/scripts")),
  ];
  if (mode === "unit") return all.filter((path) => !integrationTest(path));
  if (mode === "integration") return all.filter(integrationTest);
  if (mode === "all") return all;

  let names: Set<string>;
  if (mode === "changed") {
    const baseIndex = args.indexOf("--base");
    const changed = changedFiles(root, baseIndex >= 0 ? args[baseIndex + 1] : undefined);
    if (changed.length === 0) return [];
    names = affectedPackages(graph, changed);
  } else {
    if (args.length === 0) throw new Error("test:focused requires a package name or path");
    names = new Set<string>();
    for (const value of args) {
      const direct = graph.packages.find((pkg) => pkg.name === value);
      const byPath = direct ?? packageForPath(graph, toPosix(relative(root, resolve(root, value))));
      if (!byPath) throw new Error(`Unknown workspace package or path: ${value}`);
      names.add(byPath.name);
    }
  }
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
    relativePath.startsWith("packages/example/app/")
  ) {
    return "react-ui";
  }
  if (relativePath.startsWith("projen/")) return "projen";
  if (relativePath.startsWith("docs/scripts/")) return "docs";
  if (relativePath.startsWith("packages/example/")) return "examples";
  return "node";
}

async function runTests(root: string, files: readonly string[]): Promise<void> {
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
  const started = performance.now();
  const jobs = [...groups].map(async ([name, paths]) => {
    const groupStarted = performance.now();
    const result = await exec.spawn("bun", ["test", ...paths], {
      cwd: root,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    const seconds = ((performance.now() - groupStarted) / 1000).toFixed(2);
    logger.info(`${name}: ${paths.length} files in ${seconds}s`);
    return { name, result };
  });
  const results = await Promise.all(jobs);
  logger.info(
    `selected tests: ${files.length} files in ${((performance.now() - started) / 1000).toFixed(2)}s`,
  );
  const failed = results.filter(({ result }) => result.exitCode !== 0);
  if (failed.length > 0) {
    throw new Error(`Test groups failed: ${failed.map(({ name }) => name).join(", ")}`);
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const root = process.cwd();
  const mode = (argv[0] ?? "all") as TestMode;
  if (!["focused", "changed", "unit", "integration", "all", "graph"].includes(mode)) {
    throw new Error(`Unknown test mode: ${mode}`);
  }
  const graph = workspaceGraph(root);
  writeGraph(root, graph);
  if (mode === "graph") return;
  await runTests(root, selectedTests(root, graph, mode, argv.slice(1)));
}

if (import.meta.main) await main();
