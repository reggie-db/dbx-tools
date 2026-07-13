/**
 * The `dbxtools watch` engine: one chokidar process that keeps the generated tree
 * in sync while you edit. It runs ALONGSIDE `projen --watch` (both started by the
 * `sync` task via concurrently), which owns `.projenrc.ts` re-synth - so this
 * loop deliberately does NOT watch the projenrc, and covers the other two
 * concerns in a single debounced loop:
 *
 *   1. **new-project watch** - a package folder appeared/disappeared under a
 *      root (the package SET changed vs `pnpm-workspace.yaml`) -> full re-synth.
 *   2. **barrel watch** - a source file changed inside an existing package ->
 *      rebuild just that package's `index.ts` barrel (no re-synth). A changed
 *      tsoa controller regenerates the openapi packages first.
 *
 * A re-synth regenerates barrels too (`runSynth` sets `PROJEN_DISABLE_POST`, so we
 * call `generateBarrels()` explicitly after it). Generated files are ignored, so
 * the loop never re-triggers itself. chokidar does the watching (the library);
 * everything here is thin glue. Non-`src` config members (rare) still re-synth.
 */
import { resolve, sep } from "node:path";
import { watch } from "chokidar";
import { logger } from "../log";
import { generateBarrels } from "./barrels";
import { isTsoaController } from "./openapi";
import { packageSetChanged, runSynth } from "./scaffold";
import {
  isGeneratedFile,
  readWorkspaceMembers,
  recordedRoots,
  repoRoot,
  toPosix,
  workspacePackages,
} from "./workspace";

const log = logger.withTag("projen:watch");
const DEBOUNCE_MS = 250;

/** `src` dirs of config-only workspace members (e.g. a non-package config member). */
function configSrcDirs(): string[] {
  return readWorkspaceMembers(repoRoot)
    .filter((m) => toPosix(m).split("/").filter(Boolean).length !== 3)
    .map((m) => resolve(repoRoot, m, "src"));
}

/** Vendor/build/generated paths that must never drive the watch. */
function ignored(p: string): boolean {
  const posix = toPosix(p);
  if (/\/(node_modules|dist|lib|\.git|\.projen|build|tmp)(\/|$)/.test(posix)) return true;
  return isGeneratedFile(p);
}

/**
 * A path is CONFIG (edit -> re-synth) if it's under a config member's `src`.
 * `.projenrc.ts` is deliberately NOT here - `projen --watch` owns it.
 */
function isConfigPath(abs: string, configDirs: string[]): boolean {
  return configDirs.some((dir) => abs === dir || abs.startsWith(dir + sep));
}

/** The recorded package dir that owns `abs`, if any (for a targeted barrel rebuild). */
function ownerPackageDir(abs: string, pkgDirs: string[]): string | undefined {
  return pkgDirs.find((dir) => abs === dir || abs.startsWith(dir + sep));
}

/**
 * Re-synth. A package-set change runs the full flow (`post: true`) so pnpm links
 * the new/removed member and the post-synth component rebuilds barrels; a plain
 * config edit stays fast (`post: false`) and rebuilds barrels here.
 */
function resynth(reason: string, withInstall: boolean): void {
  log.start(`${reason} - re-synthesizing${withInstall ? " (+install)" : ""}`);
  runSynth({ post: withInstall });
  const n = withInstall ? -1 : generateBarrels();
  log.success(n < 0 ? "re-synth complete" : `re-synth complete (${n} barrel${n === 1 ? "" : "s"})`);
}

/** Start the watch loop. Builds barrels once, then watches until interrupted. */
export function startWatch(): void {
  // No initial full re-synth: `projen --watch` (started alongside this by the
  // `sync` task) does the startup synth. Just build barrels so the tree is correct
  // immediately, then watch.
  const initial = generateBarrels();
  log.info(`watching (${initial} barrel${initial === 1 ? "" : "s"} built)`);

  const workspacePackageRoots = recordedRoots().map((r) => resolve(repoRoot, r));
  const watchPaths = [...workspacePackageRoots, ...configSrcDirs()];

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let rerun = false;

  async function flush(): Promise<void> {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    const batch = [...pending];
    pending.clear();
    try {
      await runCycle(batch);
    } catch (err) {
      log.error("watch cycle failed:", err instanceof Error ? err.message : err);
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        setTimeout(() => void flush(), 0);
      }
    }
  }

  async function runCycle(batch: string[]): Promise<void> {
    const relevant = batch.map((p) => resolve(p)).filter((p) => !ignored(p));
    if (relevant.length === 0) return;

    const configDirs = configSrcDirs();
    // 1 & 2: config edit or a changed package set -> full re-synth.
    if (relevant.some((p) => isConfigPath(p, configDirs))) {
      resynth("config changed", false);
      return;
    }
    if (packageSetChanged()) {
      resynth("package set changed", true);
      return;
    }

    // 2.5: a tsoa controller changed -> regenerate the openapi packages (spec + client)
    // and rebuild its barrel. openapi is imported lazily (heavy deps).
    if (relevant.some(isTsoaController)) {
      const { generateOpenapi } = await import("./openapi");
      const dirs = await generateOpenapi();
      if (dirs.length) {
        generateBarrels({ dirs });
        log.success(`regenerated openapi (${dirs.length} package${dirs.length === 1 ? "" : "s"})`);
      }
    }

    // 3: content edit inside existing packages -> rebuild the affected barrels.
    const pkgDirs = workspacePackages().map((p) => p.dir);
    const dirs = new Set<string>();
    for (const p of relevant) {
      const owner = ownerPackageDir(p, pkgDirs);
      if (owner) dirs.add(owner);
    }
    const n = generateBarrels(dirs.size ? { dirs: [...dirs] } : {});
    if (n) log.success(`rebuilt ${n} barrel${n === 1 ? "" : "s"}`);
  }

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    ignored: (p: string) => ignored(p),
  });
  watcher.on("all", (_event, path) => {
    pending.add(path);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), DEBOUNCE_MS);
  });
  watcher.on("error", (err) => log.error("watcher error:", err));
  watcher.on("ready", () => log.info("watching for changes … (Ctrl-C to stop)"));

  process.on("SIGINT", () => {
    void watcher.close();
    process.exit(0);
  });
}
