/**
 * Portable subprocess helper built on `child_process.spawn` and line streaming.
 *
 * Each stdio fd defaults to `"inherit"`. {@link spawn} streams output
 * line-by-line into {@link ExecResult.stdoutLines}
 * / {@link ExecResult.stderrLines}; its `stdout` / `stderr` getters join those lines.
 * {@link spawnSync} keeps the captured string; its `stdout` / `stderr` getters read
 * that string directly (line arrays split lazily on read).
 * Omitted `trim` (default) applies adaptive normalization: {@link spawnSync} drops
 * at most one trailing empty line / newline `spawnSync` adds; {@link spawn} does
 * not (readline never emits that extra line). `trim: true` strips all leading/
 * trailing whitespace in both modes; `trim: false` leaves output unchanged.
 *
 * This module owns subprocess execution policy for Node and Bun packages. Reuse
 * it instead of wrapping `child_process` locally when callers need consistent
 * argv parsing, stdio capture, line callbacks, cancellation, and exit checking.
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
 *
 * @module
 */
import {
  type ChildProcess,
  type SpawnOptions,
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
} from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import * as readline from "node:readline";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { finished } from "node:stream/promises";

/** Shell-compatible exit code returned when an executable cannot be found. */
export const COMMAND_NOT_FOUND_EXIT_CODE = 127;

const DEFAULT_GRACEFUL_TIMEOUT_MS = 10_000;
const DEFAULT_FORCE_TIMEOUT_MS = 4_000;
const DEFAULT_KILL_POLL_INTERVAL_MS = 100;
const WINDOWS_PROCESS_SNAPSHOT_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() }";

/** Stdio mode for a subprocess fd. */
export type ExecStdio = "inherit" | "pipe" | "ignore";

/** Invoked once per output line when a fd is piped. */
export type LineHandler = (line: string) => void;

/** Stream lines to a handler with optional result capture. */
export interface LineOutputOptions {
  /** Invoked once per output line. */
  onLine: LineHandler;
  /** Retain lines in the completed result. Defaults to `true`. */
  capture?: boolean;
}

/**
 * Stdio config for one fd.
 *
 * - `"inherit"` / `"pipe"` / `"ignore"` — pass through to `spawn`
 * - `"capture"` — pipe the fd and append each line to the result
 * - {@link LineHandler} — pipe and invoke the handler per line (lines are still captured)
 * - {@link LineOutputOptions} — pipe and invoke the handler, with optional capture
 * - `(LineHandler | "capture")[]` — pipe; `"capture"` is a no-op marker, handlers run per line
 */
export type StdioOption =
  ExecStdio | LineHandler | LineOutputOptions | "capture" | (LineHandler | "capture")[];

/** Outcome of {@link spawn} / {@link spawnSync}: exit code, captured output, and line views. */
export type ExecResult = {
  exitCode: number;
  /**
   * Captured stdout lines. For {@link spawn} these are built while the process runs;
   * for {@link spawnSync} they are split from the captured string on first read.
   */
  readonly stdoutLines: string[];
  /**
   * Captured stderr lines. For {@link spawn} these are built while the process runs;
   * for {@link spawnSync} they are split from the captured string on first read.
   */
  readonly stderrLines: string[];
  /**
   * Captured stdout text. {@link spawnSync} reads the captured string;
   * {@link spawn} joins {@link stdoutLines}. See `trim` for normalization.
   */
  readonly stdout: string;
  /**
   * Captured stderr text. {@link spawnSync} reads the captured string;
   * {@link spawn} joins {@link stderrLines}. See `trim` for normalization.
   */
  readonly stderr: string;
};

/**
 * What {@link spawn} returns: the LIVE `ChildProcess` handle that is ALSO a
 * `Promise<ExecResult>` resolving on exit.
 *
 * This is additive - the object still satisfies `Promise<ExecResult>`, so every
 * existing `await spawn(...)` / `spawn(...).then(...)` caller is unchanged. What
 * is new is that the same value is the live child: callers that want to supervise
 * it can read `.pid`, call `.kill(signal)`, and listen for `exit` without a
 * second spawn.
 *
 * @example Await it (unchanged)
 * const { stdout } = await spawn("git", ["rev-parse", "HEAD"], { stdout: "capture" });
 *
 * @example Supervise it
 * const proc = spawn("bun", ["src/server.ts"]);
 * const shutdown = () => kill(proc);
 * const { exitCode } = await proc;
 */
export type ChildProcessResult = ChildProcess & Promise<ExecResult>;

/** Options for {@link spawn}. Extends `SpawnOptions` except `stdio`, which is driven by `stdin` / `stdout` / `stderr`. */
export type ExecOptions = Omit<SpawnOptions, "stdio"> & {
  /** `"inherit"` by default; `"pipe"` / `"ignore"` select modes, any other string is input. */
  stdin?: ExecStdio | string;
  stdout?: StdioOption;
  stderr?: StdioOption;
  /** Throw when the process exits with a non-zero code. */
  check?: boolean;
  /**
   * Omitted — adaptive trim ({@link spawnSync} drops one spawn trailing newline,
   * {@link spawn} does not); `true` — strip all leading/trailing whitespace;
   * `false` — leave captured output unchanged.
   */
  trim?: boolean;
};

/** Graceful and forced shutdown policy for {@link kill}. */
export interface KillOptions {
  /** Signal sent to the snapshotted process tree. `false` skips this phase. Defaults to `SIGTERM`. */
  gracefulSignal?: NodeJS.Signals | false;
  /** Processes receiving the graceful signal. Defaults to the complete process tree. */
  gracefulSignalTarget?: "root" | "tree";
  /** Time to wait for graceful shutdown. Defaults to 10 seconds. */
  gracefulTimeoutMs?: number;
  /** Signal sent to survivors. `false` disables forced termination. Defaults to `SIGKILL`. */
  forceSignal?: NodeJS.Signals | false;
  /** Time to poll and force newly discovered descendants. Defaults to 4 seconds. */
  forceTimeoutMs?: number;
  /** Interval used to refresh and poll the process tree. Defaults to 100 milliseconds. */
  pollIntervalMs?: number;
}

/** Stdio mode for {@link spawnSync} (no per-line callbacks). */
export type SyncExecStdio = ExecStdio | "capture";

/** Options for {@link spawnSync}. Same shape as {@link ExecOptions} but without line-handler stdio. */
export type SyncExecOptions = Omit<SpawnOptions, "stdio"> & {
  /** `"inherit"` by default; `"pipe"` / `"ignore"` select modes, any other string is input. */
  stdin?: ExecStdio | string;
  stdout?: SyncExecStdio;
  stderr?: SyncExecStdio;
  /** Throw when the process exits with a non-zero code. */
  check?: boolean;
  /**
   * Omitted — adaptive trim ({@link spawnSync} drops one spawn trailing newline,
   * {@link spawn} does not); `true` — strip all leading/trailing whitespace;
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

/** Supported command, argument-array, variadic-argument, and options call forms. */
export type SpawnArgs<T extends SpawnOptions> =
  | [command: string, ...args: string[]]
  | [command: string, args: readonly string[]]
  | [command: string, args: readonly string[], options: T]
  | [command: string, ...argsAndOptions: [...string[], T]];

interface ParsedSpawnArgs<T extends SpawnOptions> {
  command: string;
  commandArgs: string[];
  options?: T;
}

/** One operating-system process captured before tree shutdown begins. */
interface ProcessSnapshotEntry {
  pid: number;
  parentPid: number;
  identity: string;
}

/** Current retained processes plus descendants first observed by one refresh. */
interface RefreshedProcessTree {
  processes: ProcessSnapshotEntry[];
  discovered: ProcessSnapshotEntry[];
}

function parseSpawnArgs<T extends SpawnOptions>(input: SpawnArgs<T>): ParsedSpawnArgs<T> {
  let [value, ...values] = input;

  const last = values.at(-1);
  const options =
    last !== null && typeof last === "object" && !Array.isArray(last) ? last : undefined;
  const argumentValues = options ? values.slice(0, -1) : values;
  // Only the one-string form is shell-like. Explicit arguments make the command an exact executable.
  const [command, ...commandArgs] = argumentValues.length === 0 ? shlex(value!) : [value!];
  const valueArgs: string[] =
    argumentValues.length === 1 && Array.isArray(argumentValues[0])
      ? [...argumentValues[0]]
      : argumentValues;

  return {
    command: command!,
    commandArgs: [...commandArgs, ...valueArgs],
    options: options as T,
  };
}

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

/** Return whether Node failed to spawn because the executable was not found. */
function isCommandNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Return whether a process operation failed because the PID no longer exists. */
function isMissingProcessError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

/** Validate a finite non-negative timeout. */
function timeoutValue(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

/** Validate a finite positive polling interval. */
function pollIntervalValue(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("pollIntervalMs must be a finite positive number");
  }
  return value;
}

/** Parse the common `pid parentPid identity` process-snapshot format. */
function parseProcessSnapshot(lines: readonly string[]): ProcessSnapshotEntry[] {
  const snapshot: ProcessSnapshotEntry[] = [];
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(\d+)(?:\s+(.+?))?\s*$/.exec(line);
    const identity = match?.[3]?.trim();
    if (!match || !identity) continue;
    snapshot.push({
      pid: Number.parseInt(match[1]!, 10),
      parentPid: Number.parseInt(match[2]!, 10),
      identity,
    });
  }
  return snapshot;
}

/** Return whether a `/proc` record disappeared or is inaccessible during a snapshot. */
function isUnavailableProcRecord(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM";
}

/** Parse Linux `/proc/<pid>/stat` parent PID and exact process-start ticks. */
function parseLinuxProcessStat(pid: number, stat: string): ProcessSnapshotEntry | undefined {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const parentPid = Number.parseInt(fields[1]!, 10);
  const startTicks = fields[19];
  if (!Number.isSafeInteger(parentPid) || !startTicks) return undefined;
  return { pid, parentPid, identity: startTicks };
}

/** Capture Linux process identities from `/proc` without second-level truncation. */
async function linuxProcessSnapshot(): Promise<ProcessSnapshotEntry[]> {
  const directories = await readdir("/proc", { withFileTypes: true });
  const entries = await Promise.all(
    directories
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry): Promise<ProcessSnapshotEntry | undefined> => {
        const pid = Number.parseInt(entry.name, 10);
        try {
          return parseLinuxProcessStat(pid, await readFile(`/proc/${entry.name}/stat`, "utf8"));
        } catch (error) {
          if (isUnavailableProcRecord(error)) return undefined;
          throw error;
        }
      }),
  );
  return entries.filter((entry): entry is ProcessSnapshotEntry => entry !== undefined);
}

/**
 * Capture the current PID, parent PID, and process-start identity table.
 *
 * Linux reads exact start ticks from `/proc`. Windows uses the built-in
 * PowerShell CIM provider. macOS and other POSIX platforms combine `ps`
 * process start time and executable name.
 */
async function processSnapshot(): Promise<ProcessSnapshotEntry[]> {
  if (process.platform === "linux") return linuxProcessSnapshot();

  const command = process.platform === "win32" ? "powershell.exe" : "ps";
  const args =
    process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_SNAPSHOT_SCRIPT]
      : ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart=", "-o", "comm="];
  const proc = nodeSpawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = text(proc.stdout!);
  const stderr = text(proc.stderr!);
  const [exitCode, stdoutText, stderrText] = await Promise.all([waitForExit(proc), stdout, stderr]);
  if (exitCode !== 0) {
    throw new Error(
      `${commandLabel(command, args)} failed (exit ${exitCode})${
        stderrText ? `: ${stderrText.trim()}` : ""
      }`,
    );
  }
  return parseProcessSnapshot(linesFromCapturedOutput(stdoutText));
}

/** Group a process snapshot by parent PID. */
function processChildren(
  snapshot: readonly ProcessSnapshotEntry[],
): Map<number, ProcessSnapshotEntry[]> {
  const children = new Map<number, ProcessSnapshotEntry[]>();
  for (const entry of snapshot) {
    const siblings = children.get(entry.parentPid) ?? [];
    siblings.push(entry);
    children.set(entry.parentPid, siblings);
  }
  return children;
}

/** Select one snapshotted process tree in descendant-first signal order. */
function processTree(
  snapshot: readonly ProcessSnapshotEntry[],
  rootPid: number,
): ProcessSnapshotEntry[] {
  const root = snapshot.find((entry) => entry.pid === rootPid);
  if (!root) throw new Error(`Unable to identify child process ${rootPid}`);

  const children = processChildren(snapshot);
  const tree: ProcessSnapshotEntry[] = [];
  const visited = new Set<number>([rootPid]);
  const appendDescendants = (parentPid: number): void => {
    for (const child of children.get(parentPid) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      appendDescendants(child.pid);
      tree.push(child);
    }
  };
  appendDescendants(rootPid);
  tree.push(root);
  return tree;
}

/** Return whether two snapshots identify the same process lifetime. */
function sameProcess(previous: ProcessSnapshotEntry, current: ProcessSnapshotEntry): boolean {
  return previous.identity === current.identity;
}

/**
 * Refresh retained process identities and merge descendants created after the
 * initial snapshot.
 */
function refreshProcessTree(
  retained: Map<number, ProcessSnapshotEntry>,
  snapshot: readonly ProcessSnapshotEntry[],
): RefreshedProcessTree {
  const currentByPid = new Map(snapshot.map((entry) => [entry.pid, entry]));
  const children = processChildren(snapshot);
  const processes = new Map<number, ProcessSnapshotEntry>();
  const discovered: ProcessSnapshotEntry[] = [];
  const queue: ProcessSnapshotEntry[] = [];

  for (const previous of retained.values()) {
    const current = currentByPid.get(previous.pid);
    if (!current || !sameProcess(previous, current)) continue;
    retained.set(current.pid, current);
    processes.set(current.pid, current);
    queue.push(current);
  }

  const visited = new Set(processes.keys());
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]!;
    for (const child of children.get(parent.pid) ?? []) {
      const previous = retained.get(child.pid);
      if (!previous || !sameProcess(previous, child)) {
        retained.set(child.pid, child);
        discovered.push(child);
      }
      processes.set(child.pid, child);
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      queue.push(child);
    }
  }

  return { processes: [...processes.values()], discovered };
}

/** Build the per-lifetime key used to prevent repeated signals after PID reuse. */
function processIdentity(entry: ProcessSnapshotEntry): string {
  return `${entry.pid}:${entry.identity}`;
}

/** Signal each process identity once, ignoring PIDs that already exited. */
function signalProcesses(
  processes: readonly ProcessSnapshotEntry[],
  signal: NodeJS.Signals,
  signaled: Set<string>,
): void {
  const errors: unknown[] = [];
  for (const entry of processes) {
    const identity = processIdentity(entry);
    if (signaled.has(identity)) continue;
    signaled.add(identity);
    try {
      process.kill(entry.pid, signal);
    } catch (error) {
      if (!isMissingProcessError(error)) errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to send ${signal} to the complete process tree`);
  }
}

/** Pause without detaching the shutdown operation from the event loop. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Poll refreshed process snapshots until the retained tree exits or the
 * timeout elapses. Descendants created during shutdown are retained and may
 * receive the current shutdown signal once.
 */
async function waitForProcessTreeExit(
  retained: Map<number, ProcessSnapshotEntry>,
  initialProcesses: readonly ProcessSnapshotEntry[],
  signal: NodeJS.Signals,
  signaled: Set<string>,
  timeoutMs: number,
  pollIntervalMs: number,
  signalDiscovered: boolean,
): Promise<ProcessSnapshotEntry[]> {
  let survivors = [...initialProcesses];
  const deadline = Date.now() + timeoutMs;
  while (survivors.length > 0) {
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await delay(Math.min(pollIntervalMs, remainingMs));

    const refreshed = refreshProcessTree(retained, await processSnapshot());
    if (signalDiscovered && refreshed.discovered.length > 0) {
      signalProcesses(refreshed.discovered, signal, signaled);
    }
    survivors = refreshed.processes;
    if (Date.now() >= deadline) break;
  }
  return survivors;
}

/**
 * Build the object returned from {@link spawn} with live line arrays and lazy
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
 * Build the object returned from {@link spawnSync}. Captured strings are stored
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
  if (typeof option === "object") return [option.onLine];
  return [];
}

function capturesLines(option: StdioOption): boolean {
  return typeof option !== "object" || Array.isArray(option) || option.capture !== false;
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
function isPassthroughMode(option: unknown): option is ExecStdio {
  return option === "inherit" || option === "pipe" || option === "ignore";
}

/** True when stdin is data rather than one of the three reserved stdio modes. */
function isStdinPayload(stdin: ExecStdio | string | undefined): stdin is string {
  return typeof stdin === "string" && !isPassthroughMode(stdin);
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
  const capture = capturesLines(option);
  return {
    mode: "pipe",
    onLine: (line) => {
      if (capture) lines.push(line);
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
 * No-op unless `stdin` is a payload string (not a stdio mode) and
 * `proc.stdin` is available. A child that exits before consuming the payload
 * closes its pipe; EPIPE is expected in that case and is ignored.
 *
 * @param proc - Child process returned from `spawn`
 * @param stdin - Stdio mode or string payload from {@link ExecOptions}
 */
async function writeStdin(
  proc: ChildProcess,
  stdin: ExecStdio | string | undefined,
): Promise<void> {
  if (!isStdinPayload(stdin) || !proc.stdin) return;
  const completion = finished(proc.stdin, { cleanup: true });
  proc.stdin.end(stdin);
  try {
    await completion;
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "EPIPE")) throw err;
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
 * @returns Error suitable for throwing from {@link spawn}
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
 * {@link ExecResult.stderrLines} ({@link spawnSync} only; invoked lazily).
 */
function linesFromCapturedOutput(output: string): string[] {
  return output.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/**
 * Stop a child process and descendants discovered through operating-system
 * process snapshots.
 *
 * The initial tree is retained before signaling so descendants remain
 * targetable after their parent exits or they are reparented. Polling refreshes
 * the process table, merges newly created descendants, and sends each one the
 * active shutdown signal once. Either phase can be disabled for graceful-only
 * or force-only termination. macOS and other POSIX platforms use `ps`; Windows
 * uses the built-in PowerShell CIM process provider.
 *
 * Windows does not implement POSIX signal semantics. Node terminates processes
 * unconditionally for supported signals there, including `SIGTERM`.
 *
 * @param child - Root child process whose snapshotted tree should stop
 * @param options - Graceful signal, force signal, timeout, and polling policy
 * @throws When the process table cannot be captured, a signal cannot be sent,
 * or identity-matched processes remain after the final enabled phase
 */
export async function kill(child: ChildProcess, options: KillOptions = {}): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const gracefulTimeoutMs = timeoutValue(
    options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS,
    "gracefulTimeoutMs",
  );
  const forceTimeoutMs = timeoutValue(
    options.forceTimeoutMs ?? DEFAULT_FORCE_TIMEOUT_MS,
    "forceTimeoutMs",
  );
  const pollIntervalMs = pollIntervalValue(options.pollIntervalMs ?? DEFAULT_KILL_POLL_INTERVAL_MS);
  const snapshot = await processSnapshot();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const tree = processTree(snapshot, child.pid);
  const retained = new Map(tree.map((entry) => [entry.pid, entry]));
  const gracefulSignal = options.gracefulSignal === undefined ? "SIGTERM" : options.gracefulSignal;
  const gracefulSignalTarget = options.gracefulSignalTarget ?? "tree";
  const forceSignal = options.forceSignal === undefined ? "SIGKILL" : options.forceSignal;
  if (gracefulSignalTarget !== "root" && gracefulSignalTarget !== "tree") {
    throw new RangeError("gracefulSignalTarget must be root or tree");
  }
  if (gracefulSignal === false && forceSignal === false) {
    throw new Error("At least one process-tree termination signal must be enabled");
  }

  let forceTargets = tree;
  if (gracefulSignal !== false) {
    const gracefulSignaled = new Set<string>();
    const gracefulTargets = gracefulSignalTarget === "root" ? [tree.at(-1)!] : tree;
    signalProcesses(gracefulTargets, gracefulSignal, gracefulSignaled);
    forceTargets = await waitForProcessTreeExit(
      retained,
      tree,
      gracefulSignal,
      gracefulSignaled,
      gracefulTimeoutMs,
      pollIntervalMs,
      gracefulSignalTarget === "tree",
    );
  }
  if (forceTargets.length === 0) return;
  if (forceSignal === false) {
    if (gracefulSignal === false) {
      throw new Error("At least one process-tree termination signal must be enabled");
    }
    throw processTerminationError(gracefulSignal, forceTargets);
  }

  const forceSignaled = new Set<string>();
  signalProcesses(forceTargets, forceSignal, forceSignaled);
  const forcedSurvivors = await waitForProcessTreeExit(
    retained,
    forceTargets,
    forceSignal,
    forceSignaled,
    forceTimeoutMs,
    pollIntervalMs,
    true,
  );
  if (forcedSurvivors.length > 0) throw processTerminationError(forceSignal, forcedSurvivors);
}

function processTerminationError(
  signal: NodeJS.Signals,
  processes: readonly ProcessSnapshotEntry[],
): Error {
  return new Error(
    `Processes did not terminate after ${signal}: ${processes.map((entry) => entry.pid).join(", ")}`,
  );
}

/**
 * Spawn a subprocess. Returns the LIVE child handle that is ALSO a
 * `Promise<ExecResult>` resolving on exit - see {@link ChildProcessResult}.
 *
 * The promise half is the exact behaviour this function had before: it awaits
 * exit (and any line reads / stdin write), then resolves to the {@link ExecResult}
 * or rejects (spawn error other than a missing executable, or `check` on non-zero
 * exit). Existing `await spawn(...)` callers are unaffected. The handle half lets a
 * caller supervise the process (`.pid`, `.kill(signal)`, `exit` event) without a
 * second spawn.
 *
 * @param command - Executable to run (resolved on `PATH` when `shell` is set on options)
 * @param args - Arguments passed verbatim to the executable
 * @param options - Spawn, stdio, and check options
 * @returns The live `ChildProcess`, awaitable to exit code + captured output
 * @throws (on the promise) When spawn fails for a reason other than a missing
 * executable, line reads fail, or `check` is true and exit code is non-zero
 */
export function spawn(...args: SpawnArgs<ExecOptions>): ChildProcessResult {
  const { command, commandArgs, options = {} } = parseSpawnArgs(args);
  const { stdin, stdout, stderr, check, trim, ...spawnOpts } = options;
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const stdoutHandler = resolveStdio(stdout, stdoutLines);
  const stderrHandler = resolveStdio(stderr, stderrLines);
  const stdinMode: ExecStdio = isStdinPayload(stdin) ? "pipe" : (stdin ?? "inherit");

  const proc = nodeSpawn(command, commandArgs, {
    ...spawnOpts,
    stdio: [stdinMode, stdoutHandler.mode, stderrHandler.mode],
  });

  const stdinWrite = writeStdin(proc, stdin);

  const reads: Promise<void>[] = [];
  queueLineReads(reads, proc.stdout, stdoutHandler);
  queueLineReads(reads, proc.stderr, stderrHandler);

  const completion = (async (): Promise<ExecResult> => {
    let exitCode = 1;
    let commandNotFoundError: NodeJS.ErrnoException | undefined;
    try {
      exitCode = await waitForExit(proc);
      await Promise.all([stdinWrite, ...reads]);
    } catch (err) {
      if (!isCommandNotFoundError(err)) {
        await Promise.allSettled([stdinWrite, ...reads]);
        throw err;
      }
      proc.stdin?.destroy();
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      await Promise.allSettled([stdinWrite]);
      for (const read of reads) void read.catch(() => undefined);
      commandNotFoundError = err;
      exitCode = COMMAND_NOT_FOUND_EXIT_CODE;
    }

    const result = createExecResult(exitCode, stdoutLines, stderrLines, trim);
    if (check && result.exitCode !== 0) {
      const err = execError(command, commandArgs, result);
      if (commandNotFoundError) err.cause = commandNotFoundError;
      throw err;
    }
    return result;
  })();

  // Attach the promise interface onto the live child so ONE object is both. The
  // methods are bound to `completion` so `this` is the real promise; the child
  // owns no conflicting `then`/`catch`/`finally`, so this is purely additive.
  return attachPromise(proc, completion);
}

/**
 * Attach a promise's `then` / `catch` / `finally` onto a live object, returning
 * the same object typed as both. Used by {@link spawn} to make its `ChildProcess`
 * awaitable without wrapping it - so callers keep the live handle AND `await` it.
 */
function attachPromise<T extends object, R>(target: T, promise: Promise<R>): T & Promise<R> {
  const hybrid = target as T & Promise<R>;
  hybrid.then = promise.then.bind(promise);
  hybrid.catch = promise.catch.bind(promise);
  hybrid.finally = promise.finally.bind(promise);
  return hybrid;
}

/**
 * Spawn a subprocess synchronously and wait for exit.
 *
 * Unlike {@link spawn}, stdio options are limited to `"inherit"`, `"pipe"`,
 * `"ignore"`, and `"capture"` — no per-line callbacks.
 *
 * @param command - Executable to run (resolved on `PATH` when `shell` is set on options)
 * @param args - Arguments passed verbatim to the executable
 * @param spawnSync - Spawn, stdio, and check options
 * @returns Exit code, captured line arrays, and trimmed `stdout` / `stderr` getters
 * @throws When spawn fails for a reason other than a missing executable, or
 * `check` is true and exit code is non-zero
 */
export function spawnSync(...args: SpawnArgs<SyncExecOptions>): ExecResult {
  const { command, commandArgs, options = {} } = parseSpawnArgs(args);
  const { stdin, stdout, stderr, check, trim, ...spawnOpts } = options;
  const stdinMode: ExecStdio = isStdinPayload(stdin) ? "pipe" : (stdin ?? "inherit");
  const captureStdout = stdout === "capture";
  const captureStderr = stderr === "capture";
  const stdoutMode = resolveSyncStdio(stdout);
  const stderrMode = resolveSyncStdio(stderr);

  const result = nodeSpawnSync(command, commandArgs, {
    ...spawnOpts,
    encoding: captureStdout || captureStderr ? "utf8" : undefined,
    stdio: [stdinMode, stdoutMode, stderrMode],
    input: isStdinPayload(stdin) ? stdin : undefined,
  });

  const commandNotFound = isCommandNotFoundError(result.error);
  const exitCode = commandNotFound ? COMMAND_NOT_FOUND_EXIT_CODE : (result.status ?? 1);
  const stdoutText = captureStdout ? capturedText(result.stdout) : undefined;
  const stderrText = captureStderr ? capturedText(result.stderr) : undefined;
  const execResult = createSyncExecResult(exitCode, stdoutText, stderrText, trim);

  if (result.error && (!commandNotFound || check)) {
    const err = execError(command, commandArgs, execResult);
    err.cause = result.error;
    throw err;
  }

  if (check && execResult.exitCode !== 0) throw execError(command, commandArgs, execResult);
  return execResult;
}

/**
 * Splits a shell-like command into argv.
 *
 * Supports:
 *   - whitespace separators
 *   - single and double quotes
 *   - backslash escaping
 *   - escaped spaces
 *   - empty quoted strings
 *
 * If the input is malformed (for example, an unterminated quote),
 * returns the original string as a single argument.
 */
export function shlex(command: string): string[] {
  const args: string[] = [];

  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let quoted = false;

  const push = () => {
    if (quoted || current.length > 0) {
      args.push(current);
    }
    current = "";
    quoted = false;
  };

  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = undefined;
        quoted = true;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      continue;
    }

    if (/\s/.test(ch)) {
      push();
      continue;
    }

    current += ch;
  }

  // Malformed input: treat as a literal command.
  if (quote) {
    return [command];
  }

  // Trailing backslash is literal.
  if (escaped) {
    current += "\\";
  }

  push();

  return args.length ? args : [command];
}
