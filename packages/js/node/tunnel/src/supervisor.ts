import type { ChildProcess } from "node:child_process";
import { async as asyncTools, type Logger } from "@dbx-tools/shared-core";

const STABLE_CONNECTION_MS = 60_000;

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
}): ProcessSupervisor {
  const controller = new AbortController();
  let child: ChildProcess | undefined;

  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    if (child && !child.killed) child.kill("SIGTERM");
    process.off("exit", onProcessExit);
  };
  const onProcessExit = () => {
    if (child && !child.killed) child.kill("SIGTERM");
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
      if (!child.killed) child.kill("SIGTERM");
      finish({ error });
    };
    const onAbort = () => {
      if (!child.killed) child.kill("SIGTERM");
      finish({ signal: "SIGTERM" });
    };
    child.once("exit", onExit);
    child.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
