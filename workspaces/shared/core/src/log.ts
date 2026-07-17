/**
 * Tagged, leveled logging for every runtime - the one logger the whole
 * monorepo shares.
 *
 * {@link logger} resolves a tagged {@link Logger} via a {@link LoggerFactory}
 * chosen once at module load. {@link LogLevel} filtering runs through
 * {@link shouldEmit} in the consola reporter or in per-level wrappers on the
 * `console` fallbacks.
 *
 * Sink selection chains two factories with nullish coalescing (first match
 * wins):
 *
 * 1. {@link createConsolaLoggerFactory} when consola resolves and
 *    `LOG_CONSOLA_DISABLED` is not truthy.
 * 2. {@link createConsoleLoggerFactory} everywhere else.
 *
 * The console fallback writes formatted lines to `process.stderr` when it is
 * available (Bun `inspect` per argument when `LOG_BUN_CONSOLE_DISABLED` is
 * unset, otherwise `node:util` `formatWithOptions`), or delegates to global
 * `console.*` when stderr or `node:util` is unavailable. Browser hosts omit
 * the `LEVEL` text prefix (devtools show severity) and keep only the `[name]`
 * tag.
 *
 * Env toggles (read once at init): `LOG_LEVEL`, `LOG_CONSOLA_DISABLED`,
 * `LOG_BUN_CONSOLE_DISABLED`.
 *
 * Browser-safe: `process` / `Bun` / `window` / `document` are all reached
 * through `globalThis` and guarded, and consola / `node:util` load lazily, so
 * the module works in any runtime. Consola is an optional peer; the module
 * loads fine without it.
 */

import { memoize } from "./function";
import { type NameLike, toBoolean } from "./object";

/** `process`-shaped view off `globalThis`, so no node types are needed. */
interface ProcessLike {
  env?: Record<string, string | undefined>;
  stderr?: { write?: (chunk: string) => void; isTTY?: unknown };
}

/** `Bun`-shaped view off `globalThis`, so no `@types/bun` is needed. */
interface BunLike {
  env?: Record<string, string | undefined>;
  inspect?: (value: unknown, options?: { colors?: boolean; depth?: number }) => string;
}

const globalProcess = (globalThis as { process?: ProcessLike }).process;
const globalBun = (globalThis as { Bun?: BunLike }).Bun;

/**
 * Node `process.stderr` when writable, else `undefined` (stable for the
 * process). Typed loosely (`any`) because it is handed to consola's
 * `ctx.options.stdout` (a `WriteStream`) and to the console fallback's
 * `.write`, neither of which our structural {@link ProcessLike} shape satisfies
 * nominally.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globalProcessStdErr: any =
  globalProcess && typeof globalProcess.stderr?.write === "function"
    ? globalProcess.stderr
    : undefined;

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const LOG_LEVEL_RANK = Object.fromEntries(
  LOG_LEVELS.map((level, index) => [level, index]),
) as Record<LogLevel, number>;
const LOG_LEVEL_COLORS = Object.fromEntries(
  LOG_LEVELS.map((level) => {
    let color = "\x1b[90m"; // gray
    switch (level) {
      case "info":
        color = "\x1b[34m"; // blue
        break;
      case "warn":
        color = "\x1b[33m"; // yellow
        break;
      case "error":
        color = "\x1b[31m"; // red
        break;
    }
    return [level, color];
  }),
) as Record<LogLevel, string>;
const LOG_LEVEL_COLOR_RESET = "\x1b[0m";
const DEFAULT_LEVEL: LogLevel = "info";

/**
 * Supported severities, lowest to highest: `debug`, `info`, `warn`, `error`.
 * A call below the active threshold is discarded before any string work or
 * sink I/O.
 *
 * The threshold comes from `process.env.LOG_LEVEL` on every call
 * (case-insensitive, default `info` when unset, empty, or unknown) so test
 * runners and embedders can change verbosity after import without restarting
 * the process.
 */
export type LogLevel = (typeof LOG_LEVELS)[number];

export type Logger = {
  [K in LogLevel]: (...args: any[]) => void;
} & {
  /** Success message (consola `success`; falls back to `info`-level output). */
  success: (...args: any[]) => void;
  /** Start / in-progress message (consola `start`; falls back to `info`-level output). */
  start: (...args: any[]) => void;
};

/** `(name?) => Logger` sink constructor returned by the init-time factory chain. */
type LoggerFactory = (name?: string) => Logger;

/**
 * Consola-backed {@link LoggerFactory}, or `undefined` when consola is
 * disabled, fails to import, or throws during setup.
 *
 * Builds one `createConsola` instance (badge off, level `verbose`) whose
 * reporter calls {@link shouldEmit} on `logObj.type` before delegating to
 * consola's default reporters. In Node, when `globalProcessStdErr` is set,
 * recognized {@link LogLevel} types are redirected to stderr for that write.
 * Tags use `withTag` (rendered `[name]`, not merged into args).
 *
 * Memoized: the dynamic `consola` import, env checks, and `createConsola`
 * setup (plus the import/throw fallback) run once; later calls share the one
 * resolved factory (or the one resolved `undefined`). A rejection is evicted
 * by {@link memoize} so a later call retries.
 */
const createConsolaLoggerFactory = memoize(
  async (): Promise<LoggerFactory | undefined> => {
    const consolaDisabled = toBoolean(globalProcess?.env?.LOG_CONSOLA_DISABLED);
  if (!consolaDisabled) {
    try {
      const { consola, createConsola, LogLevels } = await import("consola");
      const defaultOptions = consola.options;
      const createConsolaOptions = {
        ...consola.options,
        defaults: { badge: false },
        // `LOG_LEVEL` is enforced in {@link shouldEmit}; keep consola permissive
        // so a threshold change after import is not blocked by its own filter.
        level: LogLevels.verbose,
        reporters: [
          {
            log: (logObj, ctx) => {
              const logLevel = parseLogLevel(logObj.type);
              if (!shouldEmit(logLevel, true)) return;
              const ctxStdout = ctx.options.stdout;
              try {
                if (globalProcessStdErr !== undefined && logLevel !== undefined) {
                  ctx.options.stdout = globalProcessStdErr;
                }
                defaultOptions.reporters.forEach((reporter) => reporter.log(logObj, ctx));
              } finally {
                ctx.options.stdout = ctxStdout;
              }
            },
          },
        ],
      } as NonNullable<Parameters<typeof createConsola>[0]>;
      const consolaLogger = createConsola(createConsolaOptions);
      return (name?: string) => {
        return name ? consolaLogger.withTag(name) : consolaLogger;
      };
    } catch (error) {
      console.trace("Consola is not available, fallback to console", error);
    }
  }
  return undefined;
});

/**
 * Console {@link LoggerFactory}; always succeeds.
 *
 * When `process.stderr` is available, formats each line and writes only to
 * stderr. Bun `inspect` formats each argument when enabled; otherwise
 * `util.formatWithOptions` when `node:util` loads, or a `JSON.stringify`
 * fallback when it does not. When stderr is unavailable, binds
 * {@link createFormatter} prefixes into global `console.*` calls.
 */
async function createConsoleLoggerFactory(globalProcessStdErr: any): Promise<LoggerFactory> {
  // Indirect specifier so this browser-safe module doesn't statically pull in
  // node types: `node:util` is optional (the JSON fallback covers its absence).
  const nodeUtil = "node:util";
  const utils: { inspect?: any } | undefined = await import(nodeUtil).catch(() => undefined);
  const bunInspect =
    globalBun !== undefined && !toBoolean(globalBun.env?.LOG_BUN_CONSOLE_DISABLED)
      ? globalBun.inspect
      : undefined;
  const resetColorsPrefix = bunInspect !== undefined;

  const inspect = (arg: any, colors?: boolean) => {
    if (Array.isArray(arg) || (typeof arg === "object" && arg !== null)) {
      if (bunInspect !== undefined) {
        return bunInspect(arg, {
          colors: colors,
          depth: utils?.inspect?.defaultOptions?.depth ?? undefined,
        });
      } else if (utils !== undefined) {
        return utils.inspect(arg, {
          ...utils?.inspect?.defaultOptions,
          colors: false,
        });
      } else {
        const seen = new WeakSet();
        return JSON.stringify(arg, (_, value) => {
          if (typeof value === "object" && value !== null) {
            if (seen.has(value)) return "[Circular]";
            seen.add(value);
          }
          return value;
        });
      }
    } else {
      return String(arg);
    }
  };

  const factory = (name?: string) => {
    const prefixFormatter = createFormatter(name, globalProcessStdErr, resetColorsPrefix);
    const logger = Object.fromEntries(
      LOG_LEVELS.map((level) => {
        const { prefix, colors, resetColors } = prefixFormatter(level);
        const emitter = (...args: any[]) => {
          if (!shouldEmit(level, true)) return;
          if (globalProcessStdErr !== undefined) {
            const messageParts = prefix ? [prefix] : [];
            messageParts.push(...args.map((arg) => inspect(arg, colors)));
            if (resetColors) messageParts.push(LOG_LEVEL_COLOR_RESET);
            globalProcessStdErr.write(messageParts.join(" ") + "\n");
          } else {
            let levelFn = console[level];
            if (typeof levelFn !== "function") {
              levelFn = console.log;
            }
            if (prefix) levelFn = levelFn.bind(console, prefix);
            levelFn(...args);
          }
        };
        return [level, emitter];
      }),
    ) as Logger;
    // consola sugar the console fallback doesn't have natively - route to info.
    logger.success = logger.info;
    logger.start = logger.info;
    return logger;
  };
  const defaultFactory = memoize(factory);
  return (name?: string) => (name ? factory(name) : defaultFactory());
}

/**
 * Module-scoped {@link LoggerFactory}, initialized once via top-level `await`.
 * Delegates to {@link createConsolaLoggerFactory}, then
 * {@link createConsoleLoggerFactory}. Each {@link logger} call invokes the
 * chosen factory with a resolved tag. Env toggles are read only during init.
 */
const createLogger: LoggerFactory = await (async () => {
  return (
    (await createConsolaLoggerFactory()) ??
    (await createConsoleLoggerFactory(globalProcessStdErr))
  );
})();

/**
 * Build a line prefix of `LEVEL [name]` on Node/Bun hosts, or `[name]` alone
 * in browsers (either part omitted when absent). Applies per-level ANSI color
 * when `streamSupportsColor` is true for the given stderr stream.
 */
function createFormatter(
  name: any,
  stream: any,
  resetColorsPrefix?: boolean,
): (level?: LogLevel) => { prefix: string; colors: boolean; resetColors: boolean } {
  const glob = globalThis as { window?: unknown; document?: unknown };
  const isBrowser = glob.window !== undefined && glob.document !== undefined;
  const supportsColor = !isBrowser ? streamSupportsColor(stream) : false;
  const namePrefix = name ? "[" + name + "]" : undefined;
  return (level?: LogLevel) => {
    const color = supportsColor && level !== undefined ? LOG_LEVEL_COLORS[level] : undefined;
    let prefix = [!isBrowser && level ? level.toUpperCase() : undefined, namePrefix]
      .filter(Boolean)
      .join(" ");
    let resetColors = false;
    if (color) {
      const applyResetColorsPrefix = resetColorsPrefix || "info" === level;
      if (!applyResetColorsPrefix) resetColors = true;
      prefix = applyResetColorsPrefix ? color + prefix + LOG_LEVEL_COLOR_RESET : color + prefix;
    }
    return { prefix, colors: color ? true : false, resetColors };
  };
}

/** True when `stream` is a TTY and the terminal is not `dumb`. */
function streamSupportsColor(stream?: unknown): boolean {
  if (globalProcess === undefined || typeof stream !== "object" || stream === null) return false;
  const { isTTY } = stream as { isTTY?: unknown };
  if (isTTY !== true) return false;
  const term = globalProcess.env?.TERM?.toLowerCase();
  if ("dumb" == term) return false;
  return true;
}

/** Parse a raw value as {@link LogLevel} (trimmed, case-insensitive). */
function parseLogLevel(raw: unknown): LogLevel | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  let text = typeof raw === "string" ? raw : String(raw);
  for (let i = 0; i < 2; i++) {
    if (i > 0) {
      const normalized = text.trim().toLowerCase();
      if (text === normalized) break;
      text = normalized;
    }
    if (!text) break;
    else if (text in LOG_LEVEL_RANK) {
      return text as LogLevel;
    }
  }
  return undefined;
}

/** Active threshold from `process.env.LOG_LEVEL`, default {@link DEFAULT_LEVEL}. */
function activeLevel(): LogLevel {
  return parseLogLevel(globalProcess?.env?.LOG_LEVEL) ?? DEFAULT_LEVEL;
}

/**
 * Whether `raw` meets the current `LOG_LEVEL` threshold.
 *
 * Parses `raw` as a {@link LogLevel}; when parsing fails, returns
 * `defaultResult` if supplied, otherwise `false`. Used for consola reporter
 * lines where unknown `logObj.type` values should pass through when
 * `defaultResult` is `true`.
 */
function shouldEmit(raw: unknown, defaultResult?: boolean): boolean {
  const level = parseLogLevel(raw);
  if (level === undefined) return defaultResult ?? false;
  return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[activeLevel()];
}

/**
 * Whether a call at `level` would be emitted at the current
 * `process.env.LOG_LEVEL` threshold. Use before building expensive debug
 * payloads.
 *
 * @example
 * if (isLevelEnabled("debug")) {
 *   log.debug("mounts:resolver", { contribution: await heavySnapshot() });
 * }
 */
export function isLevelEnabled(level: LogLevel): boolean {
  return shouldEmit(level);
}

const LOGGER_NAME_REGEX = /^(?:[a-z][a-z0-9+.-]*:\/\/)?.*\/([^/.]+)(?:\.[^/]+)?$/i;

/**
 * Derive the tag string from a logger name, plugin, or path. Slash- and
 * URL-shaped strings use the last path segment (extension stripped); plain
 * strings pass through unchanged. Empty or missing names -> `undefined`
 * (untagged sink).
 */
function extractLoggerName(loggerName: NameLike | string | undefined): string | undefined {
  if (!loggerName) return undefined;
  if (typeof loggerName === "string") {
    const match = loggerName.match(LOGGER_NAME_REGEX);
    return match?.[1] ?? loggerName;
  }
  return extractLoggerName(loggerName.name);
}

/**
 * Build a tagged logger for a plugin or module.
 *
 * The tag is `[name]` when `loggerName` is a non-empty string, a
 * {@link NameLike} with `name`, or a file / URL path (the basename without
 * extension is used). Consola applies the tag via `withTag` (render-time).
 * The `console` fallbacks prepend `LEVEL [name]` on Node/Bun hosts or `[name]`
 * alone in browsers via {@link createFormatter}.
 *
 * Calls below `process.env.LOG_LEVEL` are dropped by {@link shouldEmit} before
 * the sink formats or writes the line.
 *
 * @example
 * import { log } from "@dbx-tools/shared-core";
 *
 * const logger = log.logger("genie/chat");
 * logger.info("starting");
 * logger.warn("missing optional config", { reason: "no env var" });
 */
export function logger(loggerName: NameLike | string | undefined): Logger {
  const name = extractLoggerName(loggerName);
  return createLogger(name);
}
