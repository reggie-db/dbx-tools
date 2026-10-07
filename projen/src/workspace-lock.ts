/** Cross-process coordination for generated workspace mutations. */
import { resolve } from "node:path";
import * as fileLock from "@dbx-tools/core/file-lock";
import { log } from "@dbx-tools/shared-core";

const MUTATION_LOCK_SCOPE = "dbx-tools-workspace-mutation";
const WAIT_LOG_INTERVAL_MS = 5_000;
const logger = log.logger("projen:workspace-lock");

/** Optional preflight used before and after acquiring the workspace mutation lock. */
export interface WorkspaceMutationLockOptions {
  /**
   * When this returns false, skip both the lock and the callback. After the
   * lock is held it runs again so a completed holder can make the work a no-op
   * without taking the critical section only to return.
   */
  check?: () => boolean | Promise<boolean>;
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
  if (check && !(await check())) {
    return undefined;
  }
  let waitLogTimer: ReturnType<typeof setInterval> | undefined;
  try {
    return await fileLock.withFileLock(
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
          const startedAt = Date.now();
          waitLogTimer = setInterval(
            () =>
              logger.info("waiting for workspace mutation lock", {
                repository,
                elapsedMs: Date.now() - startedAt,
              }),
            WAIT_LOG_INTERVAL_MS,
          );
          waitLogTimer.unref?.();
        },
      },
    );
  } finally {
    if (waitLogTimer) clearInterval(waitLogTimer);
  }
}
