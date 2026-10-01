/**
 * Cascading cross-process mutual exclusion via a lockfile.
 *
 * Serializes concurrent *processes* (two `bun run demo` shells, a CLI beside a
 * server) on the same key. For in-process / worker-thread exclusion use
 * {@link withProcessLock} from `./process-lock.ts` instead.
 *
 * Backends:
 *
 * 1. **file** (default) — `proper-lockfile` atomic lock-directory creation,
 *    heartbeat, stale recovery, and ownership-safe release. Bun and Node use
 *    this same protocol.
 * 2. **flock** (explicit compatibility option) — `flock(2)` via Bun FFI on
 *    Unix. It remains available to callers that selected it explicitly, but a
 *    runtime-dependent cascade cannot coordinate Bun and Node.
 *
 * The first backend that can be *initialized* is used for the whole call. A busy
 * lock waits; an unavailable backend falls through to the next. Callers may only
 * bound how long to wait ({@link FileLockOptions.timeoutMs}); stale timing is
 * not configurable so every holder and waiter agrees.
 *
 * @module
 */

import { mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { asyncUtils, errorUtils, functionUtils, hash, log, object } from "@dbx-tools/shared-core";
import lockfile from "proper-lockfile";

const logger = log.logger("core:file-lock");

/** Backends {@link withFileLock} can attempt, in cascade order. */
export type FileLockBackend = "flock" | "file";

const DEFAULT_BACKENDS: readonly FileLockBackend[] = ["file"];

/** Poll interval while waiting for a contended OS lock. */
const POLL_MS = 50;

/**
 * Age after which an unrefreshed lock directory may be removed.
 * Matches `proper-lockfile`'s default. Not caller-configurable: every process
 * must share the same threshold or a live holder can be mistaken for stale.
 */
const STALE_MS = object.toNumber(process.env.FILE_LOCK_STALE_MS) ?? 10_000;

/** Heartbeat interval for refreshing lock-directory mtime (`STALE_MS / 2`). */
const UPDATE_MS = object.toNumber(process.env.FILE_LOCK_UPDATE_MS) ?? STALE_MS / 2;

/** `flock(2)` operation bits (Linux / macOS / BSD). */
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/** Result metadata when a caller wants to know which backend ran. */
export interface FileLockAcquisition {
  backend: FileLockBackend;
}

export interface FileLockOptions {
  /**
   * Directory for lockfiles. Defaults to `$TMPDIR/dbx-tools-locks`.
   */
  dir?: string;
  /** Override the backend list. Defaults to the portable `file` protocol. */
  backends?: readonly FileLockBackend[];
  /**
   * Stop waiting and throw after this many milliseconds. Omit to poll forever.
   * This is the only wait-loop knob; stale reclaim timing is fixed.
   */
  timeoutMs?: number;
  /** Invoked once the backend for this call has been chosen. */
  onAcquire?: (acquisition: FileLockAcquisition) => void;
  /** Invoked once when the selected lock is already held by another process. */
  onWait?: (acquisition: FileLockAcquisition) => void;
}

type FlockFn = (fd: number, operation: number) => number;

interface BunFfiModule {
  dlopen: (
    path: string,
    symbols: Record<string, { args: string[]; returns: string }>,
  ) => { symbols: { flock: FlockFn } };
  suffix: string;
}

/**
 * Run `fn` while holding a cross-process lock named by `key`.
 *
 * `key` is canonicalized with `object.toStableKey`, the same identity rule as
 * process and Postgres advisory locks.
 *
 * @example
 * await withFileLock(["cache", "appkit"], async () => {
 *   await migrate();
 * });
 */
export async function withFileLock<T>(
  key: unknown,
  fn: () => T | Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  if (options.timeoutMs !== undefined && options.timeoutMs < 0) {
    throw new TypeError("timeoutMs must be non-negative");
  }
  const id = lockId(key);
  const backends = options.backends ?? DEFAULT_BACKENDS;
  const dir = options.dir ?? join(tmpdir(), "dbx-tools-locks");
  const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;

  for (const backend of backends) {
    switch (backend) {
      case "flock": {
        const lockPath = join(dir, `${id}.flock`);
        const flock = await resolveFlock();
        if (!flock) {
          logger.debug("lock backend unavailable", { backend, key: id });
          continue;
        }
        logger.debug("acquiring lock", { backend, key: id, path: lockPath });
        const acquisition = { backend } as const;
        options.onAcquire?.(acquisition);
        return holdFlock(lockPath, flock, deadline, fn, () => options.onWait?.(acquisition));
      }
      case "file": {
        const lockPath = join(dir, id);
        logger.debug("acquiring lock", { backend, key: id, path: lockPath });
        const acquisition = { backend } as const;
        options.onAcquire?.(acquisition);
        return holdLockDirectory(lockPath, deadline, fn, () => options.onWait?.(acquisition));
      }
      default: {
        const _exhaustive: never = backend;
        throw new Error(`unknown file-lock backend: ${String(_exhaustive)}`);
      }
    }
  }

  throw new Error("withFileLock: no lock backend available");
}

/** Canonical filesystem-safe id for a lock key. */
function lockId(key: unknown): string {
  const stable = object
    .toOneOrMany(key)
    .map((part) => object.toStableKey(part))
    .join("\u0000");
  // Short digest so paths stay well under OS limits; collisions are fine — they
  // only merge critical sections that already shared a key string.
  return hash.fnvHash(stable);
}

/**
 * Resolve `flock(2)` through Bun FFI when possible.
 *
 * Memoized: the FFI import + libc `dlopen` run once per process. Returns
 * `undefined` on Windows, under plain Node, or when libc cannot be loaded —
 * callers fall through to the next backend. A miss is cached too, so a process
 * that cannot flock never retries the load.
 */
const resolveFlock = functionUtils.memoize(async (): Promise<FlockFn | undefined> => {
  if (process.platform === "win32") return undefined;
  if (!process.versions.bun) return undefined;

  try {
    // Dynamic specifier so `tsc` (no `@types` for `bun:ffi`) does not resolve it;
    // the import only succeeds under Bun at runtime.
    const specifier = "bun:ffi";
    const ffi = (await import(specifier)) as unknown as BunFfiModule;
    const libPath = process.platform === "darwin" ? "libSystem.B.dylib" : `libc.${ffi.suffix}`;
    const lib = ffi.dlopen(libPath, {
      flock: { args: ["i32", "i32"], returns: "i32" },
    });
    return lib.symbols.flock;
  } catch (cause) {
    logger.debug("flock FFI unavailable", { error: errorUtils.errorMessage(cause) });
    return undefined;
  }
});

async function holdFlock<T>(
  lockPath: string,
  flock: FlockFn,
  deadline: number | undefined,
  fn: () => T | Promise<T>,
  onWait: () => void,
): Promise<T> {
  await ensureParentDir(lockPath);
  const handle = await open(lockPath, "a+");
  try {
    await waitForFlock(handle.fd, flock, lockPath, deadline, onWait);
    try {
      return await fn();
    } finally {
      flock(handle.fd, LOCK_UN);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

async function waitForFlock(
  fd: number,
  flock: FlockFn,
  lockPath: string,
  deadline: number | undefined,
  onWait: () => void,
): Promise<void> {
  let waiting = false;
  for (;;) {
    const rc = flock(fd, LOCK_EX | LOCK_NB);
    if (rc === 0) return;
    if (!waiting) {
      waiting = true;
      onWait();
    }
    assertBeforeDeadline(lockPath, deadline);
    await asyncUtils.sleep(POLL_MS);
  }
}

/**
 * Portable lock-directory ownership through `proper-lockfile`.
 */
async function holdLockDirectory<T>(
  lockPath: string,
  deadline: number | undefined,
  fn: () => T | Promise<T>,
  onWait: () => void,
): Promise<T> {
  await ensureParentDir(lockPath);
  const release = await acquireLockDirectory(lockPath, deadline, onWait);
  let callbackError: unknown;
  try {
    return await fn();
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (cause) {
      if (callbackError === undefined || (cause as NodeJS.ErrnoException).code !== "ERELEASED") {
        throw cause;
      }
      logger.warn("lock release was already completed after callback failure", {
        path: lockPath,
      });
    }
  }
}

async function acquireLockDirectory(
  lockPath: string,
  deadline: number | undefined,
  onWait: () => void,
): Promise<() => Promise<void>> {
  let waiting = false;
  for (;;) {
    try {
      return await lockfile.lock(lockPath, {
        realpath: false,
        stale: STALE_MS,
        update: UPDATE_MS,
        retries: 0,
      });
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException;
      if (err.code !== "ELOCKED") throw errorUtils.toError(cause);
      if (!waiting) {
        waiting = true;
        onWait();
      }
      assertBeforeDeadline(lockPath, deadline);
      await asyncUtils.sleep(POLL_MS);
    }
  }
}

function assertBeforeDeadline(lockPath: string, deadline: number | undefined): void {
  if (deadline !== undefined && Date.now() >= deadline) {
    throw new Error(`Timed out waiting for file lock: ${lockPath}`);
  }
}

async function ensureParentDir(lockPath: string): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
}
