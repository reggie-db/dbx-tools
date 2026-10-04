import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as asyncUtils from "@dbx-tools/shared-core/async-utils";
import * as hash from "@dbx-tools/shared-core/hash";
import * as object from "@dbx-tools/shared-core/object";

interface PythonBridge {
  eval(source: string): unknown;
}

interface FileLockAcquisition {
  readonly backend: "flock" | "file";
}

interface FileLockOptions {
  readonly dir?: string;
  readonly timeoutMs?: number;
  readonly onAcquire?: (acquisition: FileLockAcquisition) => void;
  readonly onWait?: (acquisition: FileLockAcquisition) => void;
}

interface FileLockLease extends FileLockAcquisition {
  release(): Promise<void>;
}

type PythonFunction = (...args: any[]) => any;

const POLL_MS = 50;
const python = (globalThis as typeof globalThis & { python?: PythonBridge }).python;
if (!python) throw new Error("PythonMonkey globalThis.python is unavailable");

function evaluate<T extends PythonFunction>(source: string): T {
  return python!.eval(source) as T;
}

const createLock = evaluate<PythonFunction>("lambda path: __import__('filelock').FileLock(path)");
const tryAcquire = evaluate<PythonFunction>(
  `(lambda namespace: (
    __import__('builtins').exec(
      "def try_acquire(lock):\\n try:\\n  lock.acquire(timeout=0)\\n  return True\\n except __import__('filelock').Timeout:\\n  return False",
      namespace,
    ),
    namespace['try_acquire'],
  )[1])({})`,
);
const releaseLock = evaluate<PythonFunction>("lambda lock: lock.release()");

/** PythonMonkey replacement for core's explicit file-lock lease. */
export async function acquireFileLock(
  key: unknown,
  options: FileLockOptions = {},
): Promise<FileLockLease> {
  if (options.timeoutMs !== undefined && options.timeoutMs < 0) {
    throw new TypeError("timeoutMs must be non-negative");
  }
  const dir = options.dir ?? join(tmpdir(), "dbx-tools-locks");
  const lockPath = join(dir, `${lockId(key)}.flock`);
  const acquisition = { backend: "flock" } as const;
  const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
  await mkdir(dir, { recursive: true });
  const lock = createLock(lockPath);
  options.onAcquire?.(acquisition);

  let waiting = false;
  while (!tryAcquire(lock)) {
    if (!waiting) {
      waiting = true;
      options.onWait?.(acquisition);
    }
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error(`Timed out waiting for file lock: ${lockPath}`);
    }
    await asyncUtils.sleep(POLL_MS);
  }

  let active = true;
  return {
    ...acquisition,
    async release() {
      if (!active) return;
      active = false;
      releaseLock(lock);
    },
  };
}

function lockId(key: unknown): string {
  const stable = object
    .toOneOrMany(key)
    .map((part) => object.toStableKey(part))
    .join("\u0000");
  return hash.fnvHash(stable);
}
