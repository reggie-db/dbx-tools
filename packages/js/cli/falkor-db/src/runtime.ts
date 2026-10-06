/**
 * Foreground embedded FalkorDB process and optional Volume storage wiring.
 *
 * This module owns terminal signal handling and Databricks profile selection
 * for the CLI. Reuse {@link runFalkorDB} from CLI entry points instead of
 * duplicating process lifetime or Volume client construction.
 *
 * @module
 */

import { openFalkorDB } from "@dbx-tools/falkor-db/runtime";
import { log } from "@dbx-tools/shared-core";

import type { FalkorDBOptions } from "./options.ts";

const logger = log.logger("cli:falkor-db");

/** Run FalkorDB until SIGINT or SIGTERM, then close it without an implicit save. */
export async function runFalkorDB(options: FalkorDBOptions): Promise<void> {
  const database = await openFalkorDB(options);
  logger.info("foreground FalkorDB started", {
    pid: database.pid,
    socketPath: database.socketPath,
    durableStorage: Boolean(options.volume),
  });
  const shutdown = waitForShutdown();
  try {
    await shutdown.promise;
  } finally {
    await database.close();
    shutdown.dispose();
  }
}

interface ShutdownWaiter {
  readonly promise: Promise<void>;
  dispose(): void;
}

function waitForShutdown(): ShutdownWaiter {
  let resolve!: () => void;
  let requested = false;
  const promise = new Promise<void>((value) => {
    resolve = value;
  });
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (requested) return;
      requested = true;
      resolve();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return {
    promise,
    dispose() {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}
