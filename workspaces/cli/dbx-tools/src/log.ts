/**
 * Shared consola logger for dbx-tools CLI and library code.
 */
import { createConsola, LogLevels, type LogType } from "consola";

/** Fallback threshold when `LOG_LEVEL` is unset or unrecognized. */
const DEFAULT_LOG_LEVEL = LogLevels.info;

/** Matches a non-empty string of digits for numeric level parsing. */
const DIGIT_REGEXP = /^\d+$/;

/**
 * Resolve an arbitrary value to a consola {@link LogType}.
 *
 * Numbers are matched against {@link LogLevels} values. Strings are tried
 * as-is, then trimmed and lowercased; purely numeric strings (`"3"`) are parsed
 * and re-resolved like numbers. Any other type is coerced with `String()`
 * first.
 *
 * @param value - Level name, numeric level, or other coercible input.
 * @returns The matching log type, or `undefined` when nothing matches.
 */
function parseLogType(value: unknown): LogType | undefined {
  if (typeof value === "number") {
    for (const [key, level] of Object.entries(LogLevels)) {
      if (level === value) return key as LogType;
    }
    return undefined;
  } else if (typeof value === "string") {
    let strValue = value as string;
    for (let i = 0; i < 2; i++) {
      if (i > 0) {
        const normalized = strValue.trim().toLowerCase();
        if (normalized === strValue) return undefined;
        strValue = normalized;
      }
      if (!strValue) return undefined;
      else if (DIGIT_REGEXP.test(strValue)) return parseLogType(Number.parseInt(strValue, 10));
      else if (Object.hasOwn(LogLevels, strValue)) {
        return strValue as LogType;
      }
    }
    return undefined;
  } else {
    return parseLogType(String(value));
  }
}

/**
 * Resolve an arbitrary value to a consola numeric log threshold.
 *
 * @param value - Same inputs accepted by {@link parseLogType}.
 * @returns The consola level number, or `undefined` when unrecognized.
 */
function parseLogLevel(value: unknown): number | undefined {
  const logType = parseLogType(value);
  return logType ? LogLevels[logType] : undefined;
}

/**
 * The single dev logger for the toolchain.
 *
 * Both consola streams point at **stderr** so stdout stays clean for piping
 * and tool output. Verbosity is read once from `process.env.LOG_LEVEL` at
 * module load. That env var accepts either a consola level name (`info`,
 * `debug`, `trace`, ...) or its numeric value (`0` fatal/error through `5`
 * trace); anything unrecognized falls back to `info`.
 *
 * Tag per task at the call site, e.g. `logger.withTag("projen:watch")`.
 */
export const logger = createConsola({
  stdout: process.stderr,
  stderr: process.stderr,
  level: parseLogLevel(process.env.LOG_LEVEL) ?? DEFAULT_LOG_LEVEL,
});

if (import.meta.main) {
  console.log(logger.level);
  logger.debug("Hello, world!");
  logger.info("Hello, world!");
}
