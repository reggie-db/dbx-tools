/**
 * Generic file-watch utility shared by the `sync --watch` task watchers.
 *
 * `watchLoop` wraps `@dbx-tools/path`'s chokidar watcher with the
 * behavior every dbx-tools watcher wants: it debounces bursts, serializes runs (a
 * change mid-run re-runs once afterwards), drops generated paths (barrels/manifests/
 * decls - reacting to our own output would loop), exits on a watcher error chokidar
 * cannot recover from ({@link FATAL_WATCH_ERROR_CODES}), and shuts down on SIGINT. Callers
 * pass the paths to watch and an `onBatch` handler; the concern-specific glue - which
 * barrels to rebuild, when to regenerate openapi, when to re-synth - lives in the task
 * that owns it (`tasks/barrels.ts`, `tasks/openapi.ts`, `tasks/projenrc.ts`), each
 * forwarding here rather than duplicating the watch machinery.
 *
 * `watchRoots()` is the one shared input - the package roots where every
 * watchable source file lives - so the barrels and openapi watchers don't each
 * recompute it. {@link watchFiles} owns the chokidar wiring; this is thin glue.
 */
import { isAbsolute, resolve } from "node:path";
import { watch as fileScan } from "@dbx-tools/path";
import { async, log } from "@dbx-tools/shared-core";
import { isGeneratedFile, recordedRoots, repoRoot } from "./packages.ts";

const logger = log.logger("projen:watch");
const DEBOUNCE_MS = 250;

/** How long to let chokidar release its watches before exiting regardless. */
const CLOSE_GRACE_MS = 2_000;

/**
 * Watcher errors no amount of waiting recovers from: the process is out of file
 * descriptors (`EMFILE`/`ENFILE`) or the kernel watch table is full (`ENOSPC`).
 *
 * These have to end the process, because chokidar only EMITS them - it never closes
 * itself or marks the instance dead (its own source carries a
 * `TODO: emit errors properly. Example: EMFILE on Macos.`). A handler that just logs
 * therefore leaves the watcher open, still holding every descriptor it took, while
 * silently delivering no further events; and since the process stays alive, `sync`'s
 * `restartTries: -1` supervisor never sees an exit to respawn. The watcher looks
 * healthy and its outputs quietly go stale. Exiting non-zero instead hands the
 * restart to `concurrently`, which is what makes a transient exhaustion recover on
 * its own and a persistent one loud (a respawn every `RESTART_DELAY_MS`).
 *
 * Every other error is left as a logged warning: chokidar has already filtered the
 * benign `ENOENT`/`ENOTDIR` cases, and what remains (an unreadable path, say) costs
 * that one path while the rest of the tree keeps working - a restart would only hit
 * it again.
 */
const FATAL_WATCH_ERROR_CODES = new Set(["EMFILE", "ENFILE", "ENOSPC"]);

/** node-path's built-in ignore-group toggles (`{ dot, temp, test, lock, defaults }`). */
export type IgnoreGroupOptions = NonNullable<
  Parameters<typeof fileScan.watchFiles>[1]
>["ignoreOptions"];

/** The package roots (absolute), where every watchable source file lives. */
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
 * watches until SIGINT, or until a {@link FATAL_WATCH_ERROR_CODES} error makes the
 * watcher blind, which exits non-zero so `sync` respawns it.
 *
 * A failing `onBatch` is NOT fatal - the offending edit is usually the one the next
 * save fixes - so it is logged and the watch continues.
 *
 * `ignoreOptions` toggles node-path's built-in ignore groups for this watcher only
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
  let closing = false;

  /**
   * Release the watches and leave with `code`. Closing is raced against
   * {@link CLOSE_GRACE_MS} so a wedged chokidar cannot hold up a Ctrl-C, and exiting
   * reclaims the descriptors either way.
   */
  async function shutdown(code: number): Promise<void> {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    await Promise.race([watcher.close().catch(() => {}), async.sleep(CLOSE_GRACE_MS)]);
    process.exit(code);
  }

  watcher.on("all", (_event, path) => {
    pending.add(path);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), DEBOUNCE_MS);
  });
  watcher.on("error", (err) => {
    logger.error(`${tag} watcher error:`, err);
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === undefined || !FATAL_WATCH_ERROR_CODES.has(code)) return;
    logger.error(`${tag}: ${code} leaves the watcher blind - exiting so it is restarted`);
    void shutdown(1);
  });
  watcher.on("ready", () => logger.info(`${tag}: watching for changes … (Ctrl-C to stop)`));

  process.on("SIGINT", () => void shutdown(0));
}
