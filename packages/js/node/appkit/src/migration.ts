/** Shared classification and logging policy for soft database migrations. */

import { errorUtils, log, type Logger } from "@dbx-tools/shared-core";

const loggedOwnershipErrors = new Set<string>();

/** Inputs for one ownership-only migration failure. */
export interface OwnershipMigrationErrorOptions {
  /** Stable subsystem key used to deduplicate equivalent warnings. */
  readonly scope: string;
  readonly logger: Pick<Logger, "error" | "warn">;
  readonly event: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

/** Whether a migration failed because the current role does not own an object. */
export function isOwnershipMigrationError(cause: unknown): boolean {
  return errorUtils.errorContext(cause).hasMessage("must be owner");
}

/**
 * Classify and log an ownership-only migration failure once per subsystem.
 * Returns `false` for every other failure so callers can rethrow it.
 */
export function handleOwnershipMigrationError(
  cause: unknown,
  options: OwnershipMigrationErrorOptions,
): boolean {
  if (!isOwnershipMigrationError(cause)) return false;
  const message = errorUtils.errorMessage(cause);
  const key = `${options.scope}\0${message}`;
  if (loggedOwnershipErrors.has(key)) return true;
  loggedOwnershipErrors.add(key);
  if (log.isLevelEnabled("debug")) {
    options.logger.error(options.event, cause);
  } else {
    options.logger.warn(options.event, { error: message, ...options.context });
  }
  return true;
}
