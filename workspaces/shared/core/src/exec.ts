/**
 * Portable subprocess helper built on `child_process.spawn` and line streaming.
 *
 * Ported from `dbx-tools-js/packages/cli/src/exec.ts`. Each stdio fd defaults to
 * `"inherit"`. {@link exec} streams output line-by-line into {@link ExecResult.stdoutLines}
 * / {@link ExecResult.stderrLines}; its `stdout` / `stderr` getters join those lines.
 * {@link execSync} keeps the captured string; its `stdout` / `stderr` getters read
 * that string directly (line arrays split lazily on read).
 * Omitted `trim` (default) applies adaptive normalization: {@link execSync} drops
 * at most one trailing empty line / newline `spawnSync` adds; {@link exec} does
 * not (readline never emits that extra line). `trim: true` strips all leading/
 * trailing whitespace in both modes; `trim: false` leaves output unchanged.
 *
 * @example Capture command output
 * ```ts
 * const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], {
 *   stdout: "capture",
 *   stderr: "ignore",
 *   stdin: "ignore",
 * });
 * ```
 *
 * @example Stream and capture together
 * ```ts
 * await exec("pnpm", ["install"], {
 *   stdout: [(line) => console.log(line), "capture"],
 *   check: true,
 * });
 * ```
 *
 * @example Synchronous capture (no line callbacks)
 * ```ts
 * const { stdout } = execSync("git", ["rev-parse", "--show-toplevel"], {
 *   stdout: "capture",
 *   stderr: "ignore",
 *   stdin: "ignore",
 * });
 * ```
 */
import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import * as readline from "node:readline";
import { Readable } from "node:stream";

/** Stdio mode for a subprocess fd. */
export type ExecStdio = "inherit" | "pipe" | "ignore";

/** Invoked once per output line when a fd is piped. */
export type LineHandler = (line: string) => void;

/**
 * Stdio config for one fd.
 *
 * - `"inherit"` / `"pipe"` / `"ignore"` — pass through to `spawn`
 * - `"capture"` — pipe the fd and append each line to the result
 * - {@link LineHandler} — pipe and invoke the handler per line (lines are still captured)
 * - `(LineHandler | "capture")[]` — pipe; `"capture"` is a no-op marker, handlers run per line
 */
export type StdioOption = ExecStdio | LineHandler | "capture" | (LineHandler | "capture")[];

/** Outcome of {@link exec} / {@link execSync}: exit code, captured output, and line views. */
export type ExecResult = {
  exitCode: number;
  /**
   * Captured stdout lines. For {@link exec} these are built while the process runs;
   * for {@link execSync} they are split from the captured string on first read.
   */
  readonly stdoutLines: string[];
  /**
   * Captured stderr lines. For {@link exec} these are built while the process runs;
   * for {@link execSync} they are split from the captured string on first read.
   */
  readonly stderrLines: string[];
  /**
   * Captured stdout text. {@link execSync} reads the captured string;
   * {@link exec} joins {@link stdoutLines}. See `trim` for normalization.
   */
  readonly stdout: string;
  /**
   * Captured stderr text. {@link execSync} reads the captured string;
   * {@link exec} joins {@link stderrLines}. See `trim` for normalization.
   */
  readonly stderr: string;
};

/** Options for {@link exec}. Extends `SpawnOptions` except `stdio`, which is driven by `stdin` / `stdout` / `stderr`. */
export type ExecOptions = Omit<SpawnOptions, "stdio"> & {
  /** `"inherit"` by default, or a string written to the process stdin. */
  stdin?: ExecStdio | string;
  stdout?: StdioOption;
  stderr?: StdioOption;
  /** Throw when the process exits with a non-zero code. */
  check?: boolean;
  /**
   * Omitted — adaptive trim ({@link execSync} drops one spawn trailing newline,
   * {@link exec} does not); `true` — strip all leading/trailing whitespace;
   * `false` — leave captured output unchanged.
   */
  trim?: boolean;
};

/** Stdio mode for {@link execSync} (no per-line callbacks). */
export type SyncExecStdio = ExecStdio | "capture";

/** Options for {@link execSync}. Same shape as {@link ExecOptions} but without line-handler stdio. */
export type SyncExecOptions = Omit<SpawnOptions, "stdio"> & {
  /** `"inherit"` by default, or a string written to the process stdin. */
  stdin?: ExecStdio | string;
  stdout?: SyncExecStdio;
  stderr?: SyncExecStdio;
  /** Throw when the process exits with a non-zero code. */
  check?: boolean;
  /**
   * Omitted — adaptive trim ({@link execSync} drops one spawn trailing newline,
   * {@link exec} does not); `true` — strip all leading/trailing whitespace;
   * `false` — leave captured output unchanged.
   */
  trim?: boolean;
};

/**
 * Spawn stdio mode plus an optional per-line callback after {@link resolveStdio}
 * maps a {@link StdioOption} into something `spawn` can consume.
 */
type ResolvedStdio = {
  /** Value passed to `spawn`'s `stdio` tuple for this fd. */
  mode: ExecStdio;
  /** When set, each output line is appended to the capture buffer and forwarded here. */
  onLine?: LineHandler;
};

/**
 * Drop the single trailing empty entry `spawnSync` adds when splitting on a final
 * newline (`"hi\n"` -> `["hi", ""]`). Does not remove multiple trailing empties.
 */
function withoutSpawnTrailingEmptyLine(lines: readonly string[]): string[] {
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines as string[];
}

/** Remove at most one trailing newline from captured spawn stdout/stderr text. */
function trimSingleTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/** Line-array view of async-captured output. */
function normalizedAsyncLines(lines: readonly string[], trim: boolean | undefined): string[] {
  if (trim === true) return linesFromCapturedOutput(lines.join("\n").trim());
  return lines as string[];
}

/** Join async-captured lines into stdout/stderr text. */
function formatAsyncCapturedLines(lines: readonly string[], trim: boolean | undefined): string {
  const joined = lines.join("\n");
  return trim === true ? joined.trim() : joined;
}

/** Line-array view of sync-captured output. */
function normalizedSyncLines(lines: readonly string[], trim: boolean | undefined): string[] {
  if (trim === false) return lines as string[];
  if (trim === true) return linesFromCapturedOutput(lines.join("\n").trim());
  return withoutSpawnTrailingEmptyLine(lines);
}

/** Format sync-captured stdout/stderr text. */
function formatSyncCapturedText(
  text: string | undefined,
  trim: boolean | undefined,
): string | undefined {
  if (text === undefined) return undefined;
  if (trim === false) return text;
  if (trim === true) return text.trim();
  return trimSingleTrailingNewline(text);
}

/**
 * Human-readable label for a spawned command, used in error messages.
 *
 * @param command - Executable name or path
 * @param args - Arguments passed to the executable
 * @returns Backtick-wrapped `command arg1 arg2 ...` string
 */
function commandLabel(command: string, args: string[]): string {
  return `\`${command} ${args.join(" ")}\``;
}

/**
 * Build the object returned from {@link exec} with live line arrays and lazy
 * trimmed `stdout` / `stderr` getters derived from those lines.
 */
function createExecResult(
  exitCode: number,
  stdoutLines: string[],
  stderrLines: string[],
  trim: boolean | undefined,
): ExecResult {
  return {
    exitCode,
    get stdoutLines() {
      return normalizedAsyncLines(stdoutLines, trim);
    },
    get stderrLines() {
      return normalizedAsyncLines(stderrLines, trim);
    },
    get stdout() {
      return formatAsyncCapturedLines(stdoutLines, trim);
    },
    get stderr() {
      return formatAsyncCapturedLines(stderrLines, trim);
    },
  };
}

/**
 * Build the object returned from {@link execSync}. Captured strings are stored
 * as-is; `stdout` / `stderr` trim directly, and line arrays split only on read.
 */
function createSyncExecResult(
  exitCode: number,
  stdoutText: string | undefined,
  stderrText: string | undefined,
  trim: boolean | undefined,
): ExecResult {
  let stdoutLinesCache: string[] | undefined;
  let stderrLinesCache: string[] | undefined;

  const syncLines = (text: string | undefined): string[] | undefined => {
    if (text === undefined) return undefined;
    return normalizedSyncLines(linesFromCapturedOutput(text), trim);
  };

  return {
    exitCode,
    get stdoutLines() {
      if (stdoutText === undefined) return [];
      stdoutLinesCache ??= syncLines(stdoutText) ?? [];
      return stdoutLinesCache;
    },
    get stderrLines() {
      if (stderrText === undefined) return [];
      stderrLinesCache ??= syncLines(stderrText) ?? [];
      return stderrLinesCache;
    },
    get stdout() {
      return formatSyncCapturedText(stdoutText, trim) ?? "";
    },
    get stderr() {
      return formatSyncCapturedText(stderrText, trim) ?? "";
    },
  };
}

/**
 * Extract user-supplied line handlers from a {@link StdioOption}.
 *
 * The `"capture"` marker is filtered out; capture itself is always handled by
 * pushing into the line buffer inside {@link resolveStdio}.
 *
 * @param option - Stdio option that may embed one or more handlers
 * @returns Handlers to invoke after each captured line (may be empty)
 */
function lineHandlers(option: StdioOption): LineHandler[] {
  if (typeof option === "function") return [option];
  if (Array.isArray(option)) {
    return option.filter((item): item is LineHandler => item !== "capture");
  }
  return [];
}

/**
 * True when a stdio option is a string spawn mode rather than capture/handlers.
 *
 * {@link resolveStdio} still treats `"pipe"` as pipe-and-capture; only
 * `"inherit"` and `"ignore"` return without a line callback.
 *
 * @param option - Stdio option to classify
 * @returns Whether `option` is `"inherit"`, `"pipe"`, or `"ignore"`
 */
function isPassthroughMode(option: StdioOption): option is ExecStdio {
  return option === "inherit" || option === "pipe" || option === "ignore";
}

/**
 * Map a {@link StdioOption} into a spawn stdio mode and optional line callback.
 *
 * Piped modes (`"capture"`, `"pipe"`, handlers, arrays) append every line to
 * `lines` and invoke any embedded handlers. Omitted options use `defaultMode`.
 *
 * @param option - Caller stdio preference for one fd
 * @param lines - Mutable buffer that receives each piped line
 * @param defaultMode - Spawn mode when `option` is omitted (`"inherit"` by default)
 * @returns Resolved spawn mode and optional per-line callback
 */
function resolveStdio(
  option: StdioOption | undefined,
  lines: string[],
  defaultMode: ExecStdio = "inherit",
): ResolvedStdio {
  if (option === undefined) return { mode: defaultMode };
  if (isPassthroughMode(option) && option !== "pipe") return { mode: option };

  const handlers = lineHandlers(option);
  return {
    mode: "pipe",
    onLine: (line) => {
      lines.push(line);
      for (const handler of handlers) handler(line);
    },
  };
}

/**
 * Read a readable stream line-by-line and invoke `onLine` for each chunk.
 *
 * Uses `readline` so `\r\n` and bare `\n` are normalized. The interface is
 * always closed in a `finally` block.
 *
 * @param stream - Subprocess stdout or stderr stream
 * @param onLine - Callback invoked once per output line
 */
async function readLines(stream: Readable, onLine: LineHandler): Promise<void> {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) onLine(line);
  } finally {
    rl.close();
  }
}

/**
 * Start a background line read when the resolved handler pipes a stream.
 *
 * @param reads - Promise list awaited before returning the {@link ExecResult}
 * @param stream - Subprocess stream for this fd (`null` when unavailable)
 * @param handler - Resolved stdio config from {@link resolveStdio}
 */
function queueLineReads(
  reads: Promise<void>[],
  stream: Readable | null,
  handler: ResolvedStdio,
): void {
  if (handler.onLine && stream) reads.push(readLines(stream, handler.onLine));
}

/**
 * Write string stdin to a spawned process and close the stream.
 *
 * No-op unless `stdin` is a string and `proc.stdin` is available.
 *
 * @param proc - Child process returned from `spawn`
 * @param stdin - Stdio mode or string payload from {@link ExecOptions}
 */
function writeStdin(proc: ChildProcess, stdin: ExecStdio | string | undefined): void {
  if (typeof stdin === "string" && proc.stdin) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
}

/**
 * Await process exit and normalize a missing exit code to `1`.
 *
 * Rejects when spawn fails before `close` (e.g. executable not found).
 *
 * @param proc - Child process returned from `spawn`
 * @returns Resolved exit code
 */
function waitForExit(proc: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => resolve(code ?? 1));
  });
}

/**
 * Build an `Error` for a non-zero exit when {@link ExecOptions.check} is set.
 *
 * Prefers trimmed stderr text, then stdout, in the message body.
 *
 * @param command - Executable name or path
 * @param args - Arguments passed to the executable
 * @param result - Completed exec outcome with captured output
 * @returns Error suitable for throwing from {@link exec}
 */
function execError(command: string, args: string[], result: ExecResult): Error {
  const detail = result.stderr || result.stdout;
  return new Error(
    `${commandLabel(command, args)} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
  );
}

/**
 * Map a {@link SyncExecStdio} option to a `spawnSync` stdio mode.
 *
 * `"capture"` pipes the fd so output can be read into the {@link ExecResult}.
 *
 * @param option - Caller stdio preference for one fd
 * @param defaultMode - Spawn mode when `option` is omitted (`"inherit"` by default)
 * @returns Value for the `spawnSync` stdio tuple
 */
function resolveSyncStdio(
  option: SyncExecStdio | undefined,
  defaultMode: ExecStdio = "inherit",
): ExecStdio {
  if (option === undefined) return defaultMode;
  if (option === "capture") return "pipe";
  return option;
}

/**
 * Normalize raw `spawnSync` output to a UTF-8 string when capture is enabled.
 */
function capturedText(output: string | Buffer | null | undefined): string | undefined {
  if (output === null || output === undefined) return undefined;
  return typeof output === "string" ? output : output.toString("utf8");
}

/**
 * Split captured process output into lines for {@link ExecResult.stdoutLines} /
 * {@link ExecResult.stderrLines} ({@link execSync} only; invoked lazily).
 */
function linesFromCapturedOutput(output: string): string[] {
  return output.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/**
 * Spawn a subprocess and wait for exit.
 *
 * @param command - Executable to run (resolved on `PATH` when `shell` is set on options)
 * @param args - Arguments passed verbatim to the executable
 * @param options - Spawn, stdio, and check options
 * @returns Exit code, captured line arrays, and trimmed `stdout` / `stderr` getters
 * @throws When spawn fails, line reads fail, or `check` is true and exit code is non-zero
 */
export async function exec(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const { stdin, stdout, stderr, check, trim, ...spawnOpts } = options;
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const stdoutHandler = resolveStdio(stdout, stdoutLines);
  const stderrHandler = resolveStdio(stderr, stderrLines);
  const stdinMode: ExecStdio = typeof stdin === "string" ? "pipe" : (stdin ?? "inherit");

  const proc = spawn(command, args, {
    ...spawnOpts,
    stdio: [stdinMode, stdoutHandler.mode, stderrHandler.mode],
  });

  writeStdin(proc, stdin);

  const reads: Promise<void>[] = [];
  queueLineReads(reads, proc.stdout, stdoutHandler);
  queueLineReads(reads, proc.stderr, stderrHandler);

  let exitCode = 1;
  try {
    exitCode = await waitForExit(proc);
    await Promise.all(reads);
  } catch (err) {
    await Promise.allSettled(reads);
    throw err;
  }

  const result = createExecResult(exitCode, stdoutLines, stderrLines, trim);
  if (check && result.exitCode !== 0) throw execError(command, args, result);
  return result;
}

/**
 * Spawn a subprocess synchronously and wait for exit.
 *
 * Unlike {@link exec}, stdio options are limited to `"inherit"`, `"pipe"`,
 * `"ignore"`, and `"capture"` — no per-line callbacks.
 *
 * @param command - Executable to run (resolved on `PATH` when `shell` is set on options)
 * @param args - Arguments passed verbatim to the executable
 * @param options - Spawn, stdio, and check options
 * @returns Exit code, captured line arrays, and trimmed `stdout` / `stderr` getters
 * @throws When spawn fails or `check` is true and exit code is non-zero
 */
export function execSync(
  command: string,
  args: string[],
  options: SyncExecOptions = {},
): ExecResult {
  const { stdin, stdout, stderr, check, trim, ...spawnOpts } = options;
  const stdinMode: ExecStdio = typeof stdin === "string" ? "pipe" : (stdin ?? "inherit");
  const captureStdout = stdout === "capture";
  const captureStderr = stderr === "capture";
  const stdoutMode = resolveSyncStdio(stdout);
  const stderrMode = resolveSyncStdio(stderr);

  const result = spawnSync(command, args, {
    ...spawnOpts,
    encoding: captureStdout || captureStderr ? "utf8" : undefined,
    stdio: [stdinMode, stdoutMode, stderrMode],
    input: typeof stdin === "string" ? stdin : undefined,
  });

  const exitCode = result.status ?? 1;
  const stdoutText = captureStdout ? capturedText(result.stdout) : undefined;
  const stderrText = captureStderr ? capturedText(result.stderr) : undefined;
  const execResult = createSyncExecResult(exitCode, stdoutText, stderrText, trim);

  if (result.error) {
    if (check || execResult.exitCode !== 0) {
      const err = execError(command, args, execResult);
      err.cause = result.error;
      throw err;
    }
  }

  if (check && execResult.exitCode !== 0) throw execError(command, args, execResult);
  return execResult;
}
