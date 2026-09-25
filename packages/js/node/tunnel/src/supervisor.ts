import type { ChildProcess } from "node:child_process";
import { async as asyncTools, type Logger } from "@dbx-tools/shared-core";

const STABLE_CONNECTION_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
/** How long to wait after a child start before the first public liveness probe. */
const DEFAULT_HEALTH_CHECK_GRACE_MS = 45_000;
/** Interval between public liveness probes while a child is running. */
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30_000;
/** Consecutive failed probes required before killing a still-running child. */
const DEFAULT_HEALTH_CHECK_FAILURES = 2;

export interface ProcessSupervisor {
  stop(): void;
}

type ProcessOutcome = {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: unknown;
  /** Set when the supervisor killed the child after a failed liveness probe. */
  unhealthy?: true;
};

/** Retry, shutdown, and liveness policy for one supervised child process. */
export interface ProcessSupervisorOptions {
  name: string;
  logger: Logger;
  start: () => ChildProcess | Promise<ChildProcess>;
  retryDelaysMs?: readonly number[];
  shutdownGraceMs?: number;
  /**
   * Optional public liveness probe. When it returns `false` while the child is
   * still running, the supervisor kills the child so the forever-loop restarts
   * it. Used by portr to recover from an edge that dropped the subdomain
   * registration while the local process kept running (see
   * `x-portr-error-reason: unregistered-subdomain`).
   */
  isHealthy?: () => boolean | Promise<boolean>;
  healthCheckGraceMs?: number;
  healthCheckIntervalMs?: number;
  healthCheckFailures?: number;
}

export function superviseProcessForever(options: ProcessSupervisorOptions): ProcessSupervisor {
  const controller = new AbortController();
  let child: ChildProcess | undefined;

  const terminateChild = () => {
    const stoppingChild = child;
    if (!stoppingChild) return;
    stoppingChild.kill("SIGTERM");
    setTimeout(
      () => stoppingChild.kill("SIGKILL"),
      options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
    ).unref();
  };

  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    terminateChild();
    process.off("exit", onProcessExit);
  };
  const onProcessExit = () => {
    if (child) child.kill("SIGTERM");
  };
  process.once("exit", onProcessExit);

  const run = async () => {
    let failures = 0;
    while (!controller.signal.aborted) {
      const startedAt = Date.now();
      let outcome: ProcessOutcome;
      try {
        child = await options.start();
        outcome = await processOutcome(child, controller.signal, options);
      } catch (error) {
        outcome = { error };
      } finally {
        child = undefined;
      }
      if (controller.signal.aborted) return;
      if (Date.now() - startedAt >= STABLE_CONNECTION_MS) failures = 0;
      const delayMs = asyncTools.boundedRetryDelay(failures++, options.retryDelaysMs);
      options.logger.warn(`${options.name} stopped; retrying`, { ...outcome, delayMs });
      try {
        await asyncTools.sleep(delayMs, controller.signal);
      } catch {
        return;
      }
    }
  };

  void run().catch((error) => options.logger.error(`${options.name} supervisor failed`, { error }));
  return {
    stop,
  };
}

function processOutcome(
  child: ChildProcess,
  signal: AbortSignal,
  options: ProcessSupervisorOptions,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let healthTimer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;

    const finish = (outcome: ProcessOutcome) => {
      if (settled) return;
      settled = true;
      if (healthTimer) clearTimeout(healthTimer);
      child.off("exit", onExit);
      child.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) =>
      finish({ code, signal: exitSignal });
    const onError = (error: Error) => {
      child.kill("SIGTERM");
      finish({ error });
    };
    const onAbort = () => {
      finish({ signal: "SIGTERM" });
    };

    const scheduleHealthCheck = (delayMs: number) => {
      if (!options.isHealthy || settled || signal.aborted) return;
      healthTimer = setTimeout(() => {
        void runHealthCheck();
      }, delayMs);
      healthTimer.unref?.();
    };

    const runHealthCheck = async () => {
      if (!options.isHealthy || settled || signal.aborted) return;
      let healthy = true;
      try {
        healthy = await options.isHealthy();
      } catch (error) {
        // Probe errors (DNS blips, timeouts) are not proof the tunnel is dead;
        // only an explicit unhealthy result triggers a restart.
        options.logger.debug(`${options.name} health probe errored; ignoring`, { error });
        healthy = true;
      }
      if (settled || signal.aborted) return;
      if (healthy) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        const threshold = options.healthCheckFailures ?? DEFAULT_HEALTH_CHECK_FAILURES;
        options.logger.warn(`${options.name} public endpoint unhealthy`, {
          consecutiveFailures,
          threshold,
        });
        if (consecutiveFailures >= threshold) {
          options.logger.warn(`${options.name} restarting after failed public liveness probes`);
          child.kill("SIGTERM");
          setTimeout(
            () => child.kill("SIGKILL"),
            options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
          ).unref();
          finish({ unhealthy: true, signal: "SIGTERM" });
          return;
        }
      }
      scheduleHealthCheck(options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS);
    };

    child.once("exit", onExit);
    child.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    scheduleHealthCheck(options.healthCheckGraceMs ?? DEFAULT_HEALTH_CHECK_GRACE_MS);
  });
}
