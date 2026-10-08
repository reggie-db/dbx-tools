/**
 * AppKit child-process lifecycle built on `@dbx-tools/core/exec`.
 *
 * @module
 */
import * as exec from "@dbx-tools/core/exec";

/** Spawn arguments accepted by {@link AppKitChildProcess}. */
export type AppKitSpawnArgs = exec.SpawnArgs<exec.ExecOptions>;

/** Graceful and forced shutdown policy for an AppKit child process. */
export interface AppKitChildProcessOptions {
  /** Signal sent when shutdown starts. Defaults to `SIGTERM`. */
  gracefulSignal?: NodeJS.Signals;
  /** Time to wait after the graceful signal. Defaults to 7 seconds. */
  gracefulTimeoutMs?: number;
  /** Signal sent when graceful shutdown times out. Defaults to `SIGKILL`. */
  forceSignal?: NodeJS.Signals;
  /** Time to wait after the force signal. Defaults to 1 second. */
  forceTimeoutMs?: number;
}

/**
 * Start and stop one AppKit-owned subprocess.
 *
 * The spawn arguments use {@link exec.ExecOptions}, including core exec's
 * stdin, output capture, line handlers, exit checking, and trim policy.
 * Shutdown is idempotent and escalates from the graceful signal to the force
 * signal when the child does not exit within the configured timeouts.
 */
export class AppKitChildProcess {
  readonly #spawnArgs: AppKitSpawnArgs;
  readonly #options: Required<AppKitChildProcessOptions>;
  readonly #detached: boolean;

  #child?: exec.ChildProcessResult;
  #shutdownPromise?: Promise<void>;

  constructor(spawnArgs: AppKitSpawnArgs, options: AppKitChildProcessOptions = {}) {
    this.#spawnArgs = spawnArgs;
    this.#options = {
      gracefulSignal: options.gracefulSignal ?? "SIGTERM",
      gracefulTimeoutMs: options.gracefulTimeoutMs ?? 7_000,
      forceSignal: options.forceSignal ?? "SIGKILL",
      forceTimeoutMs: options.forceTimeoutMs ?? 1_000,
    };
    this.#detached = spawnOptions(spawnArgs)?.detached === true;
  }

  /** Current child handle, or `undefined` when no child is running. */
  get process(): exec.ChildProcessResult | undefined {
    return this.#child;
  }

  /** Whether the current child has not reported an exit code or signal. */
  get running(): boolean {
    return this.#child !== undefined && !hasExited(this.#child);
  }

  /** Start the configured child process. */
  start(): exec.ChildProcessResult {
    if (this.running) throw new Error("Child process is already running");
    if (this.#shutdownPromise) {
      throw new Error("Child process is shutting down or has been shut down");
    }

    const child = exec.spawn(...this.#spawnArgs);
    this.#child = child;
    void child.once("close", () => {
      if (this.#child === child) this.#child = undefined;
    });
    return child;
  }

  /** Stop the child once, escalating when graceful shutdown times out. */
  shutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#performShutdown();
    return this.#shutdownPromise;
  }

  async #performShutdown(): Promise<void> {
    const child = this.#child;
    if (!child || hasExited(child)) {
      this.#child = undefined;
      return;
    }

    signalChild(child, this.#options.gracefulSignal, this.#detached);
    if (await waitForExit(child, this.#options.gracefulTimeoutMs)) {
      if (this.#child === child) this.#child = undefined;
      return;
    }

    signalChild(child, this.#options.forceSignal, this.#detached);
    if (!(await waitForExit(child, this.#options.forceTimeoutMs))) {
      throw new Error(`Child process ${child.pid ?? "<unknown>"} did not terminate`);
    }
    if (this.#child === child) this.#child = undefined;
  }
}

function spawnOptions(args: AppKitSpawnArgs): exec.ExecOptions | undefined {
  const value = args.at(-1);
  return isExecOptions(value) ? value : undefined;
}

function isExecOptions(value: unknown): value is exec.ExecOptions {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExited(child: exec.ChildProcessResult): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalChild(
  child: exec.ChildProcessResult,
  signal: NodeJS.Signals,
  detached: boolean,
): void {
  if (detached && process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group already exited.
    }
  }
  child.kill(signal);
}

function waitForExit(child: exec.ChildProcessResult, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      void child.off("exit", onExit);
      void child.off("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);

    void child.once("exit", onExit);
    void child.once("error", onError);
    if (hasExited(child)) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}
