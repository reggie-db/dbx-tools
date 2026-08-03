/**
 * Cascading cross-process mutual exclusion via a lockfile.
 *
 * Serializes concurrent *processes* (two `bun run demo` shells, a CLI beside a
 * server) on the same key. For in-process / worker-thread exclusion use
 * {@link withProcessLock} from `./process-lock.ts` instead.
 *
 * Backends, in order:
 *
 * 1. **flock** — `flock(2)` via Bun FFI on Unix when `bun:ffi` can load libc.
 *    Not available on Windows, and not available under plain Node (no FFI).
 *    Kernel releases the lock when the fd closes (including process death).
 * 2. **file** — atomic lock-directory creation. This is the strategy used by
 *    `proper-lockfile`: `mkdir` is atomic on Windows, Unix, and network file
 *    systems where `open(..., "wx")` may not be reliable. Optional stale
 *    detection uses the directory mtime plus a heartbeat.
 *
 * The first backend that can be *initialized* is used for the whole call. A busy
 * lock waits; an unavailable backend falls through to the next.
 *
 * @module
 */

import { mkdir, open, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { async, error, functionModule, hash, log, object } from "@dbx-tools/shared-core";

const logger = log.logger("core:file-lock");

/** Backends {@link withFileLock} can attempt, in cascade order. */
export type FileLockBackend = "flock" | "file";

const DEFAULT_BACKENDS: readonly FileLockBackend[] = ["flock", "file"];

/** Poll interval while waiting for a contended OS lock. */
const POLL_MS = 50;

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
  /** Override the cascade. Defaults to `flock` → `file`. */
  backends?: readonly FileLockBackend[];
  /**
   * Stop waiting and throw after this many milliseconds. Omit to poll forever.
   */
  timeoutMs?: number;
  /**
   * Age after which an unrefreshed lock directory may be removed. Omit to
   * disable stale detection. Only used by the `file` backend.
   */
  staleMs?: number;
  /**
   * Interval for refreshing the lock directory mtime when `staleMs` is set.
   * Defaults to half of `staleMs`.
   */
  updateMs?: number;
  /** Invoked once the backend for this call has been chosen. */
  onAcquire?: (acquisition: FileLockAcquisition) => void;
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
  validateOptions(options);
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
        options.onAcquire?.({ backend });
        return holdFlock(lockPath, flock, deadline, fn);
      }
      case "file": {
        const lockPath = join(dir, `${id}.lock`);
        logger.debug("acquiring lock", { backend, key: id, path: lockPath });
        options.onAcquire?.({ backend });
        return holdLockDirectory(lockPath, deadline, options.staleMs, options.updateMs, fn);
      }
      default: {
        const _exhaustive: never = backend;
        throw new Error(`unknown file-lock backend: ${String(_exhaustive)}`);
      }
    }
  }

  throw new Error("withFileLock: no lock backend available");
}

function validateOptions(options: FileLockOptions): void {
  if (options.timeoutMs !== undefined && options.timeoutMs < 0) {
    throw new TypeError("timeoutMs must be non-negative");
  }
  if (options.staleMs !== undefined && options.staleMs <= 0) {
    throw new TypeError("staleMs must be positive");
  }
  if (options.updateMs !== undefined) {
    if (options.staleMs === undefined) {
      throw new TypeError("updateMs requires staleMs");
    }
    if (options.updateMs <= 0 || options.updateMs > options.staleMs / 2) {
      throw new TypeError("updateMs must be positive and no greater than half of staleMs");
    }
  }
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
const resolveFlock = functionModule.memoize(async (): Promise<FlockFn | undefined> => {
  if (process.platform === "win32") return undefined;
  if (!process.versions.bun) return undefined;

  try {
    // Dynamic specifier so `tsc` (no `@types` for `bun:ffi`) does not resolve it;
    // the import only succeeds under Bun at runtime.
    const specifier = "bun:ffi";
    const ffi = (await import(specifier)) as unknown as BunFfiModule;
    const libPath =
      process.platform === "darwin" ? "libSystem.B.dylib" : `libc.${ffi.suffix}`;
    const lib = ffi.dlopen(libPath, {
      flock: { args: ["i32", "i32"], returns: "i32" },
    });
    return lib.symbols.flock;
  } catch (cause) {
    logger.debug("flock FFI unavailable", { error: error.errorMessage(cause) });
    return undefined;
  }
});

async function holdFlock<T>(
  lockPath: string,
  flock: FlockFn,
  deadline: number | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  await ensureParentDir(lockPath);
  const handle = await open(lockPath, "a+");
  try {
    await waitForFlock(handle.fd, flock, lockPath, deadline);
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
): Promise<void> {
  for (;;) {
    const rc = flock(fd, LOCK_EX | LOCK_NB);
    if (rc === 0) return;
    assertBeforeDeadline(lockPath, deadline);
    await async.sleep(POLL_MS);
  }
}

/**
 * Atomic lock-directory creation — the portable / Windows path.
 *
 * `mkdir` is the same primitive used by `proper-lockfile`: it is atomic across
 * supported local and network filesystems. When stale detection is enabled,
 * the holder refreshes mtime so a live long-running lock is never reclaimed.
 */
async function holdLockDirectory<T>(
  lockPath: string,
  deadline: number | undefined,
  staleMs: number | undefined,
  updateMs: number | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  await ensureParentDir(lockPath);
  await acquireLockDirectory(lockPath, deadline, staleMs);
  const stopHeartbeat = startHeartbeat(lockPath, staleMs, updateMs);
  try {
    return await fn();
  } finally {
    stopHeartbeat();
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function acquireLockDirectory(
  lockPath: string,
  deadline: number | undefined,
  staleMs: number | undefined,
): Promise<void> {
  for (;;) {
    try {
      await mkdir(lockPath);
      return;
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw error.toError(cause);
      if (staleMs !== undefined) await maybeReclaimStale(lockPath, staleMs);
      assertBeforeDeadline(lockPath, deadline);
      await async.sleep(POLL_MS);
    }
  }
}

async function maybeReclaimStale(lockPath: string, staleMs: number): Promise<void> {
  try {
    const { mtimeMs } = await stat(lockPath);
    const age = Date.now() - mtimeMs;
    if (age < staleMs) return;
    logger.debug("reclaiming stale lock directory", { path: lockPath, ageMs: age });
    await rm(lockPath, { recursive: true, force: true });
  } catch (cause) {
    const err = cause as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw error.toError(cause);
  }
}

function startHeartbeat(
  lockPath: string,
  staleMs: number | undefined,
  updateMs: number | undefined,
): () => void {
  if (staleMs === undefined) return () => {};
  const intervalMs = updateMs ?? Math.max(1, Math.floor(staleMs / 2));
  const timer = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch((cause) => {
      logger.warn("file lock heartbeat failed", {
        path: lockPath,
        error: error.errorMessage(cause),
      });
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function assertBeforeDeadline(lockPath: string, deadline: number | undefined): void {
  if (deadline !== undefined && Date.now() >= deadline) {
    throw new Error(`Timed out waiting for file lock: ${lockPath}`);
  }
}

async function ensureParentDir(lockPath: string): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
}
