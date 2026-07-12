/**
 * The `dbxtools sync --watch` engine: one chokidar process that keeps the
 * generated tree in sync while you edit. It folds the three concerns into a
 * single debounced loop:
 *
 *   1. **projen watch**  - `.projenrc.ts` (or any in-tree config member's `src`,
 *      e.g. the engine itself) changed -> full re-synth.
 *   2. **new-project watch** - a package folder appeared/disappeared under an env
 *      root (the package SET changed vs `pnpm-workspace.yaml`) -> full re-synth.
 *   3. **barrel watch** - a source file changed inside an existing package ->
 *      rebuild just that package's `index.ts` barrel.
 *
 * A re-synth regenerates barrels too (via the post-synth component on the plain
 * `projen` path; here `runSynth` sets `PROJEN_DISABLE_POST`, so we call
 * `generateBarrels()` explicitly after it). Generated files are ignored, so the
 * loop never re-triggers itself. chokidar does the watching (the library);
 * everything here is thin glue.
 */
import { resolve, sep } from "node:path";
import { watch } from "chokidar";
import { logger } from "../log";
import { generateBarrels } from "./barrels";
import { isTsoaController } from "./openapi";
import { packageSetChanged, runSynth } from "./scaffold";
import {
  discoverPackages,
  isGeneratedFile,
  readWorkspaceMembers,
  recordedRoots,
  repoRoot,
  toPosix,
} from "./workspace";

const log = logger.withTag("projen:watch");
const DEBOUNCE_MS = 250;

const PROJENRC = resolve(repoRoot, ".projenrc.ts");

/** `src` dirs of non-env workspace members (e.g. the in-tree engine): config code. */
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

/** A path is CONFIG (edit -> re-synth) if it's the projenrc or under a config `src`. */
function isConfigPath(abs: string, configDirs: string[]): boolean {
  if (abs === PROJENRC) return true;
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

/** Start the watch loop. Runs an initial sync, then watches until interrupted. */
export function startWatch(): void {
  // Initial sync so the tree is correct before watching (mirror `dbxtools sync`).
  if (packageSetChanged()) resynth("package set changed", true);
  else {
    const n = generateBarrels();
    log.success(`initial sync (${n} barrel${n === 1 ? "" : "s"})`);
  }

  const envRoots = recordedRoots().map((r) => resolve(repoRoot, r));
  const watchPaths = [PROJENRC, ...envRoots, ...configSrcDirs()];

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

    // 2.5: a tsoa controller changed -> regenerate the openapi env (spec + client)
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
    const pkgDirs = discoverPackages().map((p) => p.dir);
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
