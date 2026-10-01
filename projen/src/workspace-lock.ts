/** Cross-process coordination for generated workspace mutations. */
import { resolve } from "node:path";
import * as fileLock from "@dbx-tools/core/file-lock";
import { log } from "@dbx-tools/shared-core";

const MUTATION_LOCK_SCOPE = "dbx-tools-workspace-mutation";
const logger = log.logger("projen:workspace-lock");

/**
 * Serialize synthesis, generated-file watchers, and release preparation for one
 * repository without coordinating unrelated worktrees or repositories.
 */
export function withWorkspaceMutationLock<T>(
  root: string,
  callback: () => T | Promise<T>,
): Promise<T> {
  const repository = resolve(root);
  return fileLock.withFileLock([MUTATION_LOCK_SCOPE, repository], callback, {
    onWait: () => logger.info("waiting for workspace mutation lock", { repository }),
  });
}
