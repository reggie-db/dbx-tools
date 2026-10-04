import { authLogger, credentialId, tokenMetadata } from "./_logging.ts";
import type { CredentialStore, LockAdapter, Token } from "./types.ts";

const logger = authLogger("memory-storage");

/** Process-local generic lease registry used by the in-memory store. */
export class MemoryLockAdapter implements LockAdapter {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #leases = new Map<string, () => void>();
  #sequence = 0;

  async acquire(key: string, timeoutMs: number): Promise<string> {
    const credential = credentialId(key);
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    try {
      logger.debug("waiting for memory lock", { credential, timeoutMs });
      await withTimeout(previous, timeoutMs, `Timed out waiting for lock ${key}`);
    } catch (error) {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
      throw error;
    }
    const lease = `${++this.#sequence}:${key}`;
    this.#leases.set(lease, () => {
      release();
      this.#leases.delete(lease);
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    logger.debug("memory lock acquired", { credential });
    return lease;
  }

  async release(lease: string): Promise<void> {
    logger.debug("releasing memory lock", {
      credential: credentialId(lease.split(":").slice(1).join(":")),
    });
    this.#leases.get(lease)?.();
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

  acquireLock(key: string, timeoutMs: number): Promise<string> {
    return this.locks.acquire(key, timeoutMs);
  }

  releaseLock(lease: string): Promise<void> {
    return this.locks.release(lease);
  }

  name(): string {
    return "memory";
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new TypeError("timeoutMs must be non-negative");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
