/**
 * AppKit child-process lifecycle built on `@dbx-tools/core/exec`.
 *
 * @module
 */
import * as exec from "@dbx-tools/core/exec";
import { asyncUtils } from "@dbx-tools/shared-core";

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 200;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 30_000;
const DEFAULT_RUN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Spawn arguments accepted by {@link AppKitChildProcess}. */
export type AppKitSpawnArgs = exec.SpawnArgs<exec.ExecOptions>;

/** Context passed to one child-process readiness probe. */
export interface AppKitChildProcessHealthCheckContext {
  /** Spawned process being checked. */
  readonly process: exec.ChildProcessResult;
  /** Aborts when shutdown begins or the readiness timeout expires. */
  readonly signal: AbortSignal;
  /** Zero-based readiness attempt. */
  readonly attempt: number;
}

/** Return `true` when the spawned process is ready to serve callers. */
export type AppKitChildProcessHealthCheck = (
  context: AppKitChildProcessHealthCheckContext,
) => boolean | PromiseLike<boolean>;

/** Readiness and tree-shutdown policy for an AppKit child process. */
export interface AppKitChildProcessOptions extends exec.KillOptions {
  /** Optional readiness probe polled after the process is spawned. */
  healthCheck?: AppKitChildProcessHealthCheck;
  /** Delay between readiness probes. Defaults to 200 milliseconds. */
  healthCheckIntervalMs?: number;
  /** Maximum time allowed for readiness. Defaults to 30 seconds. */
  healthCheckTimeoutMs?: number;
}

/** Foreground signal policy for {@link AppKitChildProcess.run}. */
export interface AppKitChildProcessRunOptions {
  /** Parent signals that trigger tree shutdown before being re-raised. */
  signals?: readonly NodeJS.Signals[];
}

/**
 * Start and stop one AppKit-owned subprocess.
 *
 * The spawn arguments use {@link exec.ExecOptions}, including core exec's
 * stdin, output capture, line handlers, exit checking, and trim policy.
 * When configured, {@link AppKitChildProcessOptions.healthCheck} is polled
 * until ready before {@link start} resolves. Shutdown aborts any active probe
 * and delegates process-tree termination to {@link exec.kill}.
 */
export class AppKitChildProcess {
  readonly #spawnArgs: AppKitSpawnArgs;
  readonly #killOptions: exec.KillOptions;
  readonly #healthCheck?: AppKitChildProcessHealthCheck;
  readonly #healthCheckIntervalMs: number;
  readonly #healthCheckTimeoutMs: number;

  #child?: exec.ChildProcessResult;
  #healthCheckController?: AbortController;
  #shutdownPromise?: Promise<void>;

  constructor(spawnArgs: AppKitSpawnArgs, options: AppKitChildProcessOptions = {}) {
    this.#spawnArgs = spawnArgs;
    const {
      healthCheck,
      healthCheckIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS,
      healthCheckTimeoutMs = DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
      ...killOptions
    } = options;
    this.#healthCheck = healthCheck;
    this.#healthCheckIntervalMs = positiveMilliseconds(
      healthCheckIntervalMs,
      "healthCheckIntervalMs",
    );
    this.#healthCheckTimeoutMs = positiveMilliseconds(healthCheckTimeoutMs, "healthCheckTimeoutMs");
    this.#killOptions = killOptions;
  }

  /** Current child handle, or `undefined` when no child is running. */
  get process(): exec.ChildProcessResult | undefined {
    return this.#child;
  }

  /** Whether the current child has not reported an exit code or signal. */
  get running(): boolean {
    return this.#child !== undefined && !hasExited(this.#child);
  }

  /** Spawn the child and resolve only after its optional readiness probe succeeds. */
  start(): Promise<void> {
    if (this.running) throw new Error("Child process is already running");
    if (this.#shutdownPromise) {
      throw new Error("Child process is shutting down or has been shut down");
    }

    const child = exec.spawn(...this.#spawnArgs);
    const controller = new AbortController();
    this.#child = child;
    this.#healthCheckController = controller;
    void child.once("close", () => {
      if (this.#child === child) this.#child = undefined;
    });
    return this.#completeStart(child, controller);
  }

  /**
   * Start, await, and shut down one foreground child while preserving parent
   * termination signals.
   */
  async run(options: AppKitChildProcessRunOptions = {}): Promise<exec.ExecResult> {
    const signals = options.signals ?? DEFAULT_RUN_SIGNALS;
    if (signals.includes("SIGKILL")) {
      throw new Error("SIGKILL cannot be intercepted by a Node process");
    }
    const handlers = new Map<NodeJS.Signals, () => void>();
    let stopping = false;
    const removeHandlers = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    for (const signal of signals) {
      const handler = () => {
        if (stopping) return;
        stopping = true;
        removeHandlers();
        void this.shutdown()
          .finally(() => process.kill(process.pid, signal))
          .catch(() => undefined);
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }

    try {
      await this.start();
      const child = this.#child;
      if (!child) throw new Error("Child process exited after startup");
      return await child;
    } finally {
      removeHandlers();
      await this.shutdown();
    }
  }

  /**
   * Abort readiness and stop the process tree once.
   *
   * An explicit non-`SIGKILL` signal runs only the graceful polling phase.
   * Explicit `SIGKILL` skips directly to forced polling. Omitting the signal
   * uses the configured graceful and forced policy.
   */
  shutdown(signal?: NodeJS.Signals): Promise<void> {
    this.#healthCheckController?.abort(
      new DOMException("Child process shutdown requested", "AbortError"),
    );
    const killOptions: exec.KillOptions =
      signal === undefined
        ? this.#killOptions
        : signal === "SIGKILL"
          ? { ...this.#killOptions, gracefulSignal: false, forceSignal: signal }
          : { ...this.#killOptions, gracefulSignal: signal, forceSignal: false };
    this.#shutdownPromise ??= this.#performShutdown(killOptions);
    return this.#shutdownPromise;
  }

  async #completeStart(child: exec.ChildProcessResult, controller: AbortController): Promise<void> {
    try {
      if (this.#healthCheck) {
        await Promise.race([
          this.#waitUntilHealthy(child, controller.signal),
          child.then((result) => {
            throw new Error(
              `Child process ${child.pid ?? "<unknown>"} exited before becoming ready ` +
                `(exit ${result.exitCode})`,
            );
          }),
        ]);
      }
    } catch (error) {
      try {
        await this.shutdown();
      } catch (shutdownError) {
        throw new AggregateError(
          [error, shutdownError],
          `Child process ${child.pid ?? "<unknown>"} failed readiness and shutdown`,
        );
      }
      throw error;
    } finally {
      if (this.#healthCheckController === controller) {
        this.#healthCheckController = undefined;
      }
    }
  }

  async #waitUntilHealthy(child: exec.ChildProcessResult, signal: AbortSignal): Promise<void> {
    const healthCheck = this.#healthCheck;
    if (!healthCheck) return;
    for await (const healthy of asyncUtils.poll(
      ({ attempt, signal: pollSignal }) =>
        healthCheck({ process: child, signal: pollSignal, attempt }),
      {
        intervalMs: this.#healthCheckIntervalMs,
        timeoutMs: this.#healthCheckTimeoutMs,
        signal,
        predicate: (healthy) => !healthy,
      },
    )) {
      if (healthy) return;
    }
  }

  async #performShutdown(options: exec.KillOptions): Promise<void> {
    const child = this.#child;
    if (!child) {
      this.#child = undefined;
      return;
    }

    await exec.kill(child, options);
    if (this.#child === child) this.#child = undefined;
  }
}

function hasExited(child: exec.ChildProcessResult): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function positiveMilliseconds(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
  return value;
}
