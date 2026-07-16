/**
 * Portable subprocess helper built on `child_process.spawn` and line streaming.
 *
 * Ported from `dbx-tools-js/packages/cli/src/exec.ts`. Each stdio fd defaults to
 * `"inherit"`. Piped fds accumulate lines on {@link ExecResult.stdoutLines} /
 * {@link ExecResult.stderrLines}; the `stdout` / `stderr` getters join and trim
 * those arrays. Pass `check: true` to throw on non-zero exit.
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
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
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
export type StdioOption =
  | ExecStdio
  | LineHandler
  | "capture"
  | (LineHandler | "capture")[];

/** Outcome of {@link exec}: exit code, line buffers, and trimmed text getters. */
export type ExecResult = {
  exitCode: number;
  /** Captured stdout lines (empty when stdout was not piped). */
  stdoutLines: string[];
  /** Captured stderr lines (empty when stderr was not piped). */
  stderrLines: string[];
  /** `stdoutLines.join("\\n").trim()` */
  readonly stdout: string;
  /** `stderrLines.join("\\n").trim()` */
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
 * Join captured lines with newlines and trim leading/trailing whitespace.
 *
 * @param lines - Line buffer from a piped stdout or stderr fd
 * @returns Single trimmed string suitable for the {@link ExecResult} getters
 */
function joinedTrimmed(lines: string[]): string {
  return lines.join("\n").trim();
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
 * trimmed `stdout` / `stderr` getters.
 *
 * @param exitCode - Process exit code (`1` when the child was terminated by signal)
 * @param stdoutLines - Mutable stdout capture buffer (referenced by the result)
 * @param stderrLines - Mutable stderr capture buffer (referenced by the result)
 * @returns {@link ExecResult} whose getters reflect the final line buffers
 */
function createExecResult(exitCode: number, stdoutLines: string[], stderrLines: string[]): ExecResult {
  return {
    exitCode,
    stdoutLines,
    stderrLines,
    get stdout() {
      return joinedTrimmed(stdoutLines);
    },
    get stderr() {
      return joinedTrimmed(stderrLines);
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
  if (Array.isArray(option)) return option.filter((item): item is LineHandler => item !== "capture");
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
function queueLineReads(reads: Promise<void>[], stream: Readable | null, handler: ResolvedStdio): void {
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
  const { stdin, stdout, stderr, check, ...spawnOpts } = options;
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

  const result = createExecResult(exitCode, stdoutLines, stderrLines);
  if (check && result.exitCode !== 0) throw execError(command, args, result);
  return result;
}
