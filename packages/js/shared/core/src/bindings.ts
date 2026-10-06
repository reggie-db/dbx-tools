/**
 * Binding-safe access to the shared logging threshold.
 *
 * @module
 */

import { activeLevel, isLevelEnabled, type LogLevel } from "./log.ts";

/** Return the active logging threshold. */
export function logActiveLevel(): LogLevel {
  return activeLevel();
}

/** Return whether the current logging threshold enables `level`. */
export function logLevelEnabled(level: LogLevel): boolean {
  return isLevelEnabled(level);
}
