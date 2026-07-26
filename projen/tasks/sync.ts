#!/usr/bin/env -S npx tsx
import { fileURLToPath } from "node:url";
import concurrently from "concurrently";
import { log } from "@dbx-tools/shared-core";
import { runSynth } from "../src/scaffold";

const logger = log.logger("projen:sync");

/**
 * Backoff before a crashed watcher is respawned. A watcher that dies during startup
 * (unparseable config, a bad import) would otherwise hot-loop, so this debounces the
 * retry into something readable while still recovering promptly once the offending
 * file is fixed. Deliberately a flat delay rather than concurrently's `"exponential"`,
 * whose unbounded `2^n` growth would leave a watcher dead for hours after a bad
 * afternoon of crashes.
 */
const RESTART_DELAY_MS = 5_000;

/** How long to let the watcher process trees die on shutdown before exiting regardless. */
const STOP_GRACE_MS = 2_000;

/** Absolute path to a sibling task script, so `concurrently`'s cwd doesn't matter. */
function taskPath(script: string): string {
  return fileURLToPath(new URL(`./${script}`, import.meta.url));
}

if (!process.argv.includes("--watch")) {
  // One-shot: full synth (+install + barrels via the post-synth component). This is
  // the scriptable path, so a failed synth stays a failed exit code.
  logger.start("synthesizing");
  runSynth({ post: true });
  logger.success("synced");
} else {
  // Watch: one initial full synth to bring the tree up to date, then three focused
  // watchers under `concurrently`. The projenrc watcher is the intelligent stand-in
  // for stock `projen --watch` - it re-synths (+install) ONLY when `.projenrc.ts` or
  // a configured `syncResynthPaths` entry changes, while barrels/openapi keep generated
  // OUTPUT fresh on source edits with no full synth.
  //
  // VS Code auto-runs this on folder open, so from here down nothing is allowed to be
  // fatal: errors are logged and retried, and only a stop signal ends the task.
  logger.start("initial sync");
  try {
    runSynth({ post: true });
    logger.success("synced - watching (Ctrl-C to stop)");
  } catch (err) {
    // A tree that doesn't synth is precisely when the watcher is most useful: the edit
    // that repairs it is the one the projenrc watcher is sitting there waiting for.
    logger.error(
      "initial sync failed - watching anyway:",
      err instanceof Error ? err.message : err,
    );
  }

  const { result } = concurrently(
    [
      { command: `tsx "${taskPath("projenrc.ts")}"`, name: "projenrc", prefixColor: "magenta" },
      { command: `tsx "${taskPath("barrels.ts")}" --watch`, name: "barrels", prefixColor: "cyan" },
      { command: `tsx "${taskPath("openapi.ts")}" --watch`, name: "openapi", prefixColor: "green" },
    ],
    {
      prefix: "name",
      // No `killOthersOn`: one watcher falling over is no reason to tear the other two
      // down. `-1` is concurrently's spelling for "restart forever", so a crashed
      // watcher comes back instead of silently leaving its outputs stale.
      restartTries: -1,
      restartDelay: RESTART_DELAY_MS,
    },
  );

  let stopping = false;

  /**
   * Wind the watchers down for good.
   *
   * Restarting forever means an ordinary SIGTERM would be answered by respawning every
   * watcher, so the task has to opt out explicitly. SIGINT is the one signal concurrently
   * neutralizes - it rewrites that exit to 0 before the restart controller sees it - so
   * re-emitting it is how we say "stop" in a language the supervisor understands.
   *
   * Killing is asynchronous (concurrently shells out to `ps` to walk each process tree)
   * and can outlive `result`, which is how a plain SIGTERM used to leave orphaned
   * watchers behind. The timer holds the process open until the kills land, and doubles
   * as the backstop that leaves anyway if one of them wedges.
   */
  function stop(): void {
    if (stopping) return;
    stopping = true;
    process.emit("SIGINT", "SIGINT");
    setTimeout(() => process.exit(0), STOP_GRACE_MS);
  }

  // Registered after `concurrently()` so its own signal handler - the one that actually
  // kills the children - is already in place by the time ours can fire.
  for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, stop);

  // With infinite restarts this settles only once a stop signal has wound the watchers
  // down, so there is no failure left to report. When `stop()` is driving, the pending
  // grace timer keeps us alive past this point and owns the exit.
  await result.catch(() => {});
}
