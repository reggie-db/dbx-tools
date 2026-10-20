/** Cross-process coordination for generated workspace mutations. */
import { resolve } from "node:path";
import { withFileLock } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";

const MUTATION_LOCK_SCOPE = "dbx-tools-workspace-mutation";
const WAIT_LOG_INTERVAL_MS = 5_000;
const logger = log.logger("projen:workspace-lock");

/** Cancelable recurring task returned by a workspace-lock scheduler. */
export interface WorkspaceMutationLockTimer {
  cancel(): void;
}

/** Clock and recurring scheduler used by workspace-lock wait logging. */
export interface WorkspaceMutationLockScheduler {
  now(): number;
  repeat(callback: () => void, intervalMs: number): WorkspaceMutationLockTimer;
}

const _systemScheduler: WorkspaceMutationLockScheduler = {
  now: Date.now,
  repeat(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    timer.unref?.();
    return { cancel: () => clearInterval(timer) };
  },
};

/** Optional preflight used before and after acquiring the workspace mutation lock. */
export interface WorkspaceMutationLockOptions {
  /**
   * When this returns false, skip both the lock and the callback. After the
   * lock is held it runs again so a completed holder can make the work a no-op
   * without taking the critical section only to return.
   */
  check?: () => boolean | Promise<boolean>;
  /** Scheduler override for deterministic wait-logging tests. */
  scheduler?: WorkspaceMutationLockScheduler;
}

/**
 * Serialize synthesis, generated-file watchers, and release preparation for one
 * repository without coordinating unrelated worktrees or repositories.
 *
 * `check` is check-lock-check: a false result before acquire never waits, and a
 * false result after acquire releases immediately without running `callback`.
 */
export async function withWorkspaceMutationLock<T>(
  root: string,
  callback: () => T | Promise<T>,
  options?: WorkspaceMutationLockOptions,
): Promise<T | undefined> {
  const repository = resolve(root);
  const check = options?.check;
  const scheduler = options?.scheduler ?? _systemScheduler;
  if (check && !(await check())) {
    return undefined;
  }
  let waitLogTimer: WorkspaceMutationLockTimer | undefined;
  try {
    return await withFileLock(
      [MUTATION_LOCK_SCOPE, repository],
      async () => {
        if (check && !(await check())) {
          return undefined;
        }
        return callback();
      },
      {
        backends: process.platform === "win32" ? ["file"] : ["flock", "file"],
        onWait: () => {
          if (waitLogTimer) return;
          const startedAt = scheduler.now();
          waitLogTimer = scheduler.repeat(
            () =>
              logger.info("waiting for workspace mutation lock", {
                repository,
                elapsedMs: scheduler.now() - startedAt,
              }),
            WAIT_LOG_INTERVAL_MS,
          );
        },
      },
    );
  } finally {
    waitLogTimer?.cancel();
  }
}
