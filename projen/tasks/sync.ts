#!/usr/bin/env -S bun
/** Synthesize once or keep generated source current with one focused watcher. */
import { basename, relative, resolve } from "node:path";
import { relativePathWithin } from "@dbx-tools/core";
import { watchFiles } from "@dbx-tools/path";
import { log, pluralize, toError } from "@dbx-tools/shared-core";
import { z } from "zod";
import { runTaskMain } from "./cli.ts";
import { runTaskCommand } from "../src/_task-command.ts";
import { generateBarrels } from "../src/barrels.ts";
import {
  DEFAULT_PACKAGE_ROOTS,
  isGeneratedFile,
  packageDirOfModule,
  readDbxToolsConfig,
  recordedPackages,
  resolveRepoRoot,
  scanPackages,
  toPosix,
  type RecordedPackage,
} from "../src/packages.ts";
import {
  generatePythonNodeBindings,
  resolveAllPythonNodeBindings,
  type ResolvedPythonNodeBindings,
} from "../src/python-node-bindings.ts";

const logger = log.logger("projen:sync");
const DEBOUNCE_MS = 250;
const FATAL_WATCH_ERROR_CODES = new Set(["EMFILE", "ENFILE", "ENOSPC"]);

export const SyncOptionsSchema = z
  .object({
    watch: z.boolean().default(false).describe("Keep generated source current after synthesis"),
  })
  .describe("Synchronize generated project and source files");

/** Filesystem and generated-metadata state used to classify one watcher batch. */
export interface SyncSnapshot {
  readonly projectRoot: string;
  readonly packageRoots: readonly string[];
  readonly packages: readonly RecordedPackage[];
  readonly resynthPaths: readonly string[];
  readonly runtimeInputs: readonly string[];
  readonly runtimeBuildScript?: string;
  readonly bindingInputs: ReadonlySet<string>;
  readonly bindingDirectories: readonly string[];
}

/** Focused work selected for one debounced watcher batch. */
export interface SyncChangePlan {
  readonly action: "focused" | "ignore" | "synthesize";
  readonly barrelDirectories: readonly string[];
  readonly bindings: boolean;
  readonly changed: readonly string[];
  readonly reasons: readonly string[];
  readonly runtime: boolean;
}

/** Optional filesystem context that avoids a package scan for content-only edits. */
export interface PlanSyncChangesOptions {
  readonly checkTopology?: boolean;
}

function uniquePaths(paths: Iterable<string>): string[] {
  return [...new Set([...paths].map((path) => resolve(path)))].sort();
}

function isWithin(base: string, path: string): boolean {
  return relativePathWithin(base, path) !== undefined;
}

function configuredPackageRoots(projectRoot: string): string[] {
  const configured = readDbxToolsConfig(projectRoot)?.packageRoots ?? DEFAULT_PACKAGE_ROOTS;
  return uniquePaths(configured.map((path) => resolve(projectRoot, path)));
}

function bindingState(
  projectRoot: string,
  configs: readonly ResolvedPythonNodeBindings[],
): {
  readonly directories: string[];
  readonly inputs: Set<string>;
} {
  const inputs = new Set<string>();
  const directories = new Set<string>();
  for (const config of configs) {
    inputs.add(resolve(config.pyproject));
    for (const input of config.sourceInputs) inputs.add(resolve(projectRoot, input));
    for (const override of config.functionOverrides) inputs.add(resolve(override.handlerFile));
    for (const directory of config.workspaceDirectories) {
      directories.add(resolve(directory));
      inputs.add(resolve(directory, "package.json"));
    }
  }
  return { directories: uniquePaths(directories), inputs: new Set(uniquePaths(inputs)) };
}

/** Read the generated sync configuration and current package/binding catalogue. */
export function syncSnapshot(projectRoot: string = resolveRepoRoot()): SyncSnapshot {
  const root = resolve(projectRoot);
  const config = readDbxToolsConfig(root);
  const runtimeDirectory = config?.pythonNodeRuntimeDirectory
    ? resolve(root, config.pythonNodeRuntimeDirectory)
    : undefined;
  const bindings = bindingState(root, resolveAllPythonNodeBindings(root));
  return {
    projectRoot: root,
    packageRoots: configuredPackageRoots(root),
    packages: recordedPackages(root),
    resynthPaths: uniquePaths([
      resolve(root, ".projenrc.ts"),
      ...(config?.syncResynthPaths ?? []).map((path) => resolve(root, path)),
    ]),
    runtimeInputs: runtimeDirectory
      ? [resolve(runtimeDirectory, "build-runtime.ts"), resolve(runtimeDirectory, "shims")]
      : [],
    ...(runtimeDirectory
      ? { runtimeBuildScript: resolve(runtimeDirectory, "build-runtime.ts") }
      : {}),
    bindingInputs: bindings.inputs,
    bindingDirectories: bindings.directories,
  };
}

/** Minimal watcher inputs; package roots cover their contained binding sources. */
export function syncWatchPaths(snapshot: SyncSnapshot): string[] {
  const directories = [
    ...snapshot.packageRoots,
    ...snapshot.resynthPaths,
    ...snapshot.runtimeInputs,
  ];
  return uniquePaths([
    ...directories,
    ...[...snapshot.bindingInputs].filter(
      (input) => !directories.some((directory) => isWithin(directory, input)),
    ),
  ]);
}

function recordedPackagePaths(snapshot: SyncSnapshot): string[] {
  return snapshot.packages
    .map(({ path }) => path)
    .filter((path) =>
      snapshot.packageRoots.some((root) => {
        const relativeRoot = toPosix(relative(snapshot.projectRoot, root));
        return path.startsWith(`${relativeRoot}/`);
      }),
    )
    .sort();
}

/** Whether filesystem package discovery no longer matches generated workspace metadata. */
export function packageTopologyChanged(snapshot: SyncSnapshot): boolean {
  const roots = snapshot.packageRoots.map((root) => toPosix(relative(snapshot.projectRoot, root)));
  const scanned = scanPackages(snapshot.projectRoot, roots).map(({ memberPath }) => memberPath);
  return scanned.join("\n") !== recordedPackagePaths(snapshot).join("\n");
}

function packageForModule(snapshot: SyncSnapshot, path: string): string | undefined {
  for (const root of snapshot.packageRoots) {
    const directory = packageDirOfModule(root, path);
    if (!directory) continue;
    if (snapshot.packages.some((pkg) => resolve(pkg.dir) === resolve(directory))) return directory;
  }
  return undefined;
}

/** Classify changes without running synthesis or a generator. */
export function planSyncChanges(
  snapshot: SyncSnapshot,
  changedPaths: readonly string[],
  options: PlanSyncChangesOptions = {},
): SyncChangePlan {
  const changed = uniquePaths(changedPaths).filter((path) => !isGeneratedFile(path));
  const reasons = snapshot.resynthPaths
    .filter((input) => changed.some((path) => isWithin(input, path)))
    .map((path) => toPosix(relative(snapshot.projectRoot, path) || "."));
  const packageRootChanged = changed.some((path) =>
    snapshot.packageRoots.some((root) => isWithin(root, path)),
  );
  if ((options.checkTopology ?? true) && packageRootChanged && packageTopologyChanged(snapshot)) {
    reasons.push("package topology");
  }
  if (reasons.length > 0) {
    return {
      action: "synthesize",
      barrelDirectories: [],
      bindings: false,
      changed,
      reasons,
      runtime: false,
    };
  }

  const barrelDirectories = uniquePaths(
    changed.flatMap((path) => {
      const directory = packageForModule(snapshot, path);
      return directory ? [directory] : [];
    }),
  );
  const runtime = snapshot.runtimeInputs.some((input) =>
    changed.some((path) => isWithin(input, path)),
  );
  const bindings =
    changed.some(
      (path) => basename(path) === "pyproject.toml" || snapshot.bindingInputs.has(path),
    ) ||
    barrelDirectories.some((directory) =>
      snapshot.bindingDirectories.some((bindingDirectory) => isWithin(bindingDirectory, directory)),
    );
  const action = barrelDirectories.length > 0 || bindings || runtime ? "focused" : "ignore";
  return { action, barrelDirectories, bindings, changed, reasons: [], runtime };
}

function synthesize(root: string): void {
  runTaskCommand(root, "bun", [resolve(root, ".projenrc.ts")]);
}

function describePlan(plan: SyncChangePlan, root: string): string {
  if (plan.action === "synthesize") return `full synthesis (${plan.reasons.join(", ")})`;
  if (plan.action === "ignore") return "no generated owner";
  return (
    [
      ...(plan.barrelDirectories.length > 0
        ? [`${pluralize(plan.barrelDirectories.length, "package barrel")}`]
        : []),
      ...(plan.bindings ? ["Python Node bindings"] : []),
      ...(plan.runtime ? ["Python Node runtime"] : []),
    ].join(", ") || toPosix(relative(root, plan.changed[0] ?? root))
  );
}

function displayPaths(root: string, paths: readonly string[]): string[] {
  return paths.map((path) => toPosix(relative(root, path) || "."));
}

/** Run the single focused watcher after one initial synthesis. */
async function watch(root: string): Promise<void> {
  let snapshot = syncSnapshot(root);
  let watchedPaths = syncWatchPaths(snapshot);
  const pending = new Map<string, boolean>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let rerun = false;
  let closing = false;
  let watcher: Awaited<ReturnType<typeof watchFiles>>;

  async function refreshSnapshot(): Promise<void> {
    const next = syncSnapshot(root);
    const nextPaths = syncWatchPaths(next);
    const previous = new Set(watchedPaths);
    const upcoming = new Set(nextPaths);
    const added = nextPaths.filter((path) => !previous.has(path));
    const removed = watchedPaths.filter((path) => !upcoming.has(path));
    if (added.length > 0) watcher.add(added);
    if (removed.length > 0) await watcher.unwatch(removed);
    snapshot = next;
    watchedPaths = nextPaths;
  }

  async function flush(): Promise<void> {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    const changed = [...pending.keys()];
    const checkTopology = [...pending.values()].some(Boolean);
    pending.clear();
    try {
      const plan = planSyncChanges(snapshot, changed, { checkTopology });
      if (plan.changed.length === 0) return;
      const details = { paths: displayPaths(root, plan.changed) };
      if (plan.action === "ignore") logger.debug(`selected ${describePlan(plan, root)}`, details);
      else logger.info(`selected ${describePlan(plan, root)}`, details);
      if (plan.action === "synthesize") {
        synthesize(root);
        await refreshSnapshot();
        logger.success("synthesis complete");
      } else if (plan.action === "focused") {
        if (plan.barrelDirectories.length > 0) {
          const count = generateBarrels({ projectRoot: root, dirs: [...plan.barrelDirectories] });
          logger.success(
            count === 0 ? "barrels already current" : `updated ${pluralize(count, "barrel")}`,
          );
        }
        if (plan.bindings) {
          generatePythonNodeBindings(root);
          await refreshSnapshot();
          logger.success("Python Node bindings current");
        }
        if (plan.runtime && snapshot.runtimeBuildScript) {
          runTaskCommand(root, "bun", [snapshot.runtimeBuildScript]);
          logger.success("Python Node runtime current");
        }
      }
    } catch (error) {
      logger.error("sync cycle failed; watching for the next change", { error: toError(error) });
    } finally {
      running = false;
      if (rerun || pending.size > 0) {
        rerun = false;
        setTimeout(() => void flush(), 0);
      }
    }
  }

  watcher = await watchFiles(watchedPaths, {
    cwd: root,
    ignoreInitial: true,
    ignoreOptions: { dot: false },
  });

  async function shutdown(code: number): Promise<void> {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    await watcher.close().catch(() => {});
    process.exit(code);
  }

  watcher.on("all", (event, path) => {
    const absolute = resolve(root, path);
    pending.set(absolute, (pending.get(absolute) ?? false) || event !== "change");
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), DEBOUNCE_MS);
  });
  watcher.on("error", (error) => {
    logger.error("file watcher error", { error: toError(error) });
    const code = (error as NodeJS.ErrnoException).code;
    if (code && FATAL_WATCH_ERROR_CODES.has(code)) void shutdown(1);
  });
  watcher.on("ready", () => logger.success("watching for focused sync changes (Ctrl-C to stop)"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => void shutdown(0));
  }
}

export const main = await runTaskMain(
  import.meta,
  SyncOptionsSchema,
  async ({ watch: continuous }) => {
    const root = resolveRepoRoot();
    if (!continuous) {
      synthesize(root);
      return;
    }
    logger.start("initial synthesis");
    try {
      synthesize(root);
      logger.success("initial synthesis complete");
    } catch (error) {
      logger.error("initial synthesis failed; starting the watcher for corrective edits", {
        error: toError(error),
      });
    }
    await watch(root);
  },
);
