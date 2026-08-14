import type { ChildProcess } from "node:child_process";
import { async as asyncTools, type Logger } from "@dbx-tools/shared-core";

const STABLE_CONNECTION_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

export interface ProcessSupervisor {
  stop(): void;
}

type ProcessOutcome = {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: unknown;
};

export function superviseProcessForever(options: {
  name: string;
  logger: Logger;
  start: () => ChildProcess | Promise<ChildProcess>;
  retryDelaysMs?: readonly number[];
  shutdownGraceMs?: number;
}): ProcessSupervisor {
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
        outcome = await processOutcome(child, controller.signal);
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

function processOutcome(child: ChildProcess, signal: AbortSignal): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const finish = (outcome: ProcessOutcome) => {
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
    child.once("exit", onExit);
    child.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
