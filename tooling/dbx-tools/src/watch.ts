/**
 * The `projen watch` engine: one process that keeps `packages/*` in sync.
 *
 * On any change under a package `src/` tree it, in order:
 *   0. regenerates the `openapi` scope if an `@openapi`-annotated source changed;
 *   1. re-synthesizes projen config when the set of packages changed;
 *   2. rebuilds the affected package's root barrel (see `./barrels`).
 *
 * The files these steps generate (manifests/tsconfigs, `vite.config.ts`, barrels,
 * and the entire generated `openapi` scope) are ignored, so our own writes never
 * feed back in. Events are debounced and processed one batch at a time.
 */
import { relative } from "node:path";
import chokidar from "chokidar";
import { generateBarrels } from "./barrels";
import { logger } from "./log";
import { generateOpenapi, mayHaveAnnotations } from "./openapi";
import { packageSignature, runSynth } from "./scaffold";
import { PACKAGES_DIR, isGeneratedFile, packageDirOf, repoRoot, toPosix } from "./workspace";

const log = logger.withTag("projen:watch");

/** Paths we generate ourselves (or vendor dirs) - watching them would echo. */
function isIgnored(path: string): boolean {
  const posix = toPosix(path);
  if (/\/(node_modules|dist|\.git|\.projen|build|tmp)(\/|$)/.test(posix)) return true;
  if (/\/packages\/openapi\//.test(posix)) return true; // the openapi scope is generated
  return isGeneratedFile(path);
}

const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let rerun = false;
let lastSignature = "";

function schedule(path: string): void {
  pending.add(path);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flush(), 200);
}

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
  // 0) regenerate the openapi scope if an annotated source changed.
  const openapiDirs = batch.some(mayHaveAnnotations) ? await generateOpenapi() : [];

  // 1) re-synth if the package set changed (new/removed package, incl. openapi).
  const signature = packageSignature();
  const changed = signature !== lastSignature;
  if (changed) {
    lastSignature = signature;
    log.start("package set changed - re-synthesizing");
    runSynth();
    log.info("run `pnpm install` to link any new workspace deps");
  }

  // 2) barrels: affected package dirs (+ regenerated openapi dirs), or all.
  let dirs: string[] | undefined;
  if (!changed) {
    const set = new Set<string>();
    for (const p of batch) {
      const dir = packageDirOf(p);
      if (dir) set.add(dir);
    }
    for (const dir of openapiDirs) set.add(dir);
    if (set.size === 0) return;
    dirs = [...set];
  }
  const n = generateBarrels(dirs ? { dirs } : {});
  if (n) log.success(`rebuilt ${n} barrel${n === 1 ? "" : "s"}`);
}

/** Start watching. Runs an initial full sync, then watches until interrupted. */
export async function startWatch(): Promise<void> {
  log.info("projen watch - barrels + scaffold + openapi");

  await generateOpenapi(); // may create packages/openapi/* before the synth below
  runSynth();
  lastSignature = packageSignature();
  const n = generateBarrels();
  log.success(`initial sync: ${n} barrel${n === 1 ? "" : "s"}`);

  const watcher = chokidar.watch(PACKAGES_DIR, {
    ignoreInitial: true,
    ignored: (p: string) => isIgnored(p),
  });
  watcher.on("all", (_event, path) => schedule(path));
  watcher.on("error", (err) => log.error("watcher error:", err));
  watcher.on("ready", () =>
    log.info(`watching ${toPosix(relative(repoRoot, PACKAGES_DIR))}/ … (Ctrl-C to stop)`),
  );

  process.on("SIGINT", () => {
    void watcher.close();
    process.exit(0);
  });
}
