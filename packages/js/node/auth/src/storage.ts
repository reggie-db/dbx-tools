import { authLogger, credentialId, tokenMetadata } from "./_logging.ts";
import type { CredentialStore, LockAdapter, Token } from "./types.ts";

const logger = authLogger("memory-storage");

/** One queued waiter for a held key: resolved when promoted, rejected on timeout. */
interface MemoryLockWaiter {
  resolve: (lease: string) => void;
  reject: (error: unknown) => void;
}

/**
 * A key's current owner lease plus its FIFO queue of waiters.
 *
 * Owner and queue live in one entry so the key is never half-present: it is
 * dropped only when it is both unowned and unwanted. A waiter that times out
 * removes only itself from `queue` and never disturbs `lease`, so a timed-out
 * waiter can no longer let a later caller bypass the active holder.
 */
interface MemoryLockState {
  lease: string;
  queue: MemoryLockWaiter[];
}

/**
 * Process-local keyed mutex used by the in-memory store.
 *
 * Modeled on `@dbx-tools/core`'s `withProcessLock` coordinator: one holder per
 * key, the rest queue in arrival order, distinct keys proceed concurrently.
 * Waiting is purely promise-based, so a waiter never blocks the event loop and,
 * by default, waits indefinitely - a holder may legitimately run for minutes
 * (e.g. an interactive `databricks auth login` that opens a browser). A finite
 * `timeoutMs` is opt-in for callers that prefer to fail fast.
 */
export class MemoryLockAdapter implements LockAdapter {
  readonly #states = new Map<string, MemoryLockState>();
  #sequence = 0;

  acquire(key: string, timeoutMs?: number): Promise<string> {
    const credential = credentialId(key);
    const state = this.#states.get(key);
    if (!state) {
      const lease = this.#nextLease(key);
      this.#states.set(key, { lease, queue: [] });
      logger.debug("memory lock acquired", { credential });
      return Promise.resolve(lease);
    }
    logger.debug("waiting for memory lock", { credential, timeoutMs });
    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: MemoryLockWaiter = {
        resolve: (lease) => {
          if (timer) clearTimeout(timer);
          logger.debug("memory lock acquired", { credential });
          resolve(lease);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      };
      state.queue.push(waiter);
      // A timer is created only for a finite positive budget. Omitted, Infinity,
      // or non-positive all mean "wait forever" - no timer to leak or fire.
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          const index = state.queue.indexOf(waiter);
          if (index >= 0) state.queue.splice(index, 1);
          waiter.reject(new Error(`Timed out waiting for lock ${key}`));
        }, timeoutMs);
      }
    });
  }

  release(lease: string): Promise<void> {
    const key = lease.split(":").slice(1).join(":");
    logger.debug("releasing memory lock", { credential: credentialId(key) });
    const state = this.#states.get(key);
    // Ignore a stale release from anyone who no longer owns the key (a timed-out
    // or superseded lease). Honoring it would revoke the lock from the holder.
    if (!state || state.lease !== lease) return Promise.resolve();
    const next = state.queue.shift();
    if (!next) {
      this.#states.delete(key);
      return Promise.resolve();
    }
    state.lease = this.#nextLease(key);
    next.resolve(state.lease);
    return Promise.resolve();
  }

  #nextLease(key: string): string {
    return `${++this.#sequence}:${key}`;
  }
}

/** Process-local credential store with per-key refresh locks. */
export class MemoryCredentialStore implements CredentialStore {
  readonly #tokens = new Map<string, Token>();

  constructor(private readonly locks: LockAdapter = new MemoryLockAdapter()) {}

  async load(key: string): Promise<Token | undefined> {
    const token = this.#tokens.get(key);
    logger.debug("loaded memory credential", {
      credential: credentialId(key),
      token: tokenMetadata(token),
    });
    return token ? structuredClone(token) : undefined;
  }

  async prepareWrite(): Promise<void> {}

  async save(key: string, token: Token): Promise<void> {
    this.#tokens.set(key, structuredClone(token));
    logger.debug("saved memory credential", {
      credential: credentialId(key),
      token: tokenMetadata(token),
    });
  }

  async remove(key: string): Promise<void> {
    this.#tokens.delete(key);
    logger.debug("removed memory credential", { credential: credentialId(key) });
  }

  acquireLock(key: string, timeoutMs?: number): Promise<string> {
    return this.locks.acquire(key, timeoutMs);
  }

  releaseLock(lease: string): Promise<void> {
    return this.locks.release(lease);
  }

  name(): string {
    return "memory";
  }
}
