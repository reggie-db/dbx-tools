/**
 * Generic file-watch utility shared by the `sync --watch` task watchers.
 *
 * `watchLoop` wraps `@dbx-tools/node-file-scan`'s chokidar watcher with the
 * behavior every dbx-tools watcher wants: it debounces bursts, serializes runs (a
 * change mid-run re-runs once afterwards), drops generated paths (barrels/manifests/
 * decls - reacting to our own output would loop), and shuts down on SIGINT. Callers
 * pass the paths to watch and an `onBatch` handler; the concern-specific glue - which
 * barrels to rebuild, when to regenerate openapi, when to re-synth - lives in the task
 * that owns it (`tasks/barrels.ts`, `tasks/openapi.ts`, `tasks/projenrc.ts`), each
 * forwarding here rather than duplicating the watch machinery.
 *
 * `watchRoots()` is the one shared input - the workspace package roots where every
 * watchable source file lives - so the barrels and openapi watchers don't each
 * recompute it. {@link watchFiles} owns the chokidar wiring; this is thin glue.
 */
import { isAbsolute, resolve } from "node:path";
import { watch as fileScan } from "@dbx-tools/node-file-scan";
import { log } from "@dbx-tools/shared-core";
import { isGeneratedFile, recordedRoots, repoRoot } from "./workspace";

const logger = log.logger("projen:watch");
const DEBOUNCE_MS = 250;

/** file-scan's built-in ignore-group toggles (`{ dot, temp, test, lock, defaults }`). */
export type IgnoreGroupOptions = NonNullable<
  Parameters<typeof fileScan.watchFiles>[1]
>["ignoreOptions"];

/** The workspace package roots (absolute), where every watchable source file lives. */
export function watchRoots(): string[] {
  return recordedRoots().map((r) => resolve(repoRoot, r));
}

/**
 * Generated paths (barrels, manifests, tsconfigs, decls) must never drive a watch -
 * they change *because* we generate, so reacting would loop.
 */
function ignoredPath(path: string): boolean {
  const abs = isAbsolute(path) ? path : resolve(repoRoot, path);
  return isGeneratedFile(abs);
}

/**
 * Shared debounce/flush machinery backed by `watchFiles`. Watches `paths` and, on
 * each debounced batch of non-generated changes, calls `onBatch` with the absolute
 * changed paths. Runs are serialized (a change during a run re-runs once afterwards);
 * watches until SIGINT.
 *
 * `ignoreOptions` toggles file-scan's built-in ignore groups for this watcher only
 * (e.g. the projenrc watcher passes `{ dot: false }` so its lone dotfile target,
 * `.projenrc.ts`, isn't pruned by the default dotfile group and left with nothing to
 * watch - which would let the process exit immediately).
 */
export function watchLoop(
  tag: string,
  paths: string[],
  onBatch: (changed: string[]) => void | Promise<void>,
  ignoreOptions?: IgnoreGroupOptions,
): void {
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
    const relevant = [...pending]
      .map((p) => (isAbsolute(p) ? p : resolve(repoRoot, p)))
      .filter((p) => !ignoredPath(p));
    pending.clear();
    try {
      if (relevant.length) await onBatch(relevant);
    } catch (err) {
      logger.error(`${tag} cycle failed:`, err instanceof Error ? err.message : err);
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        setTimeout(() => void flush(), 0);
      }
    }
  }

  const watcher = fileScan.watchFiles(paths, {
    cwd: repoRoot,
    ignoreInitial: true,
    ignore: (path) => ignoredPath(path),
    ignoreOptions,
  });
  watcher.on("all", (_event, path) => {
    pending.add(path);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), DEBOUNCE_MS);
  });
  watcher.on("error", (err) => logger.error(`${tag} watcher error:`, err));
  watcher.on("ready", () => logger.info(`${tag}: watching for changes … (Ctrl-C to stop)`));

  process.on("SIGINT", () => {
    void watcher.close();
    process.exit(0);
  });
}
