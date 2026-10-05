import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { acquireFileLock, type FileLockLease } from "@dbx-tools/core/file-lock";

import { authLogger, credentialId, tokenMetadata } from "./_logging.ts";
import { AuthError } from "./errors.ts";
import type { CredentialStore, LockAdapter, Token } from "./types.ts";
import { FileLayout } from "./types.ts";

const logger = authLogger("memory-storage");
const fileLogger = authLogger("file-storage");

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

interface TokenCache {
  version: number;
  tokens: Record<string, unknown>;
}

class FileLocks implements LockAdapter {
  private readonly leases = new Map<string, FileLockLease>();

  constructor(private readonly lockDirectory: string) {}

  async acquire(key: string, timeoutMs?: number): Promise<string> {
    fileLogger.debug("waiting for file lock", {
      credential: credentialId(key),
      timeoutMs,
    });
    const lease = await acquireFileLock(key, { dir: this.lockDirectory, timeoutMs });
    const id = randomUUID();
    this.leases.set(id, lease);
    fileLogger.debug("file lock acquired", {
      credential: credentialId(key),
      backend: lease.backend,
    });
    return id;
  }

  async release(id: string): Promise<void> {
    const lease = this.leases.get(id);
    if (!lease) return;
    this.leases.delete(id);
    await lease.release();
    fileLogger.debug("file lock released", { backend: lease.backend });
  }
}

/** File-backed credential store preserving unrelated Databricks CLI entries. */
export class FileCredentialStore implements CredentialStore {
  private readonly locks: LockAdapter;

  constructor(
    private readonly root = join(homedir(), ".databricks"),
    private readonly layout = FileLayout.Single,
    locks?: LockAdapter,
  ) {
    this.locks = locks ?? new FileLocks(join(root, "locks"));
  }

  async load(key: string): Promise<Token | undefined> {
    const store = this.forKey(key);
    return store.withCacheLock(async () => {
      const token = deserializeToken((await store.readCache()).tokens[key]);
      fileLogger.debug("loaded file credential", {
        credential: credentialId(key),
        layout: this.layout,
        token: tokenMetadata(token),
      });
      return token;
    });
  }

  async prepareWrite(): Promise<void> {
    await ensureDirectory(this.root, 0o700);
    fileLogger.debug("prepared credential directory", { layout: this.layout });
  }

  async save(key: string, token: Token): Promise<void> {
    const store = this.forKey(key);
    await store.withCacheLock(async () => {
      const cache = await store.readCache();
      cache.tokens[key] = serializeToken(token);
      await store.writeCache(cache);
      fileLogger.debug("saved file credential", {
        credential: credentialId(key),
        layout: this.layout,
        token: tokenMetadata(token),
      });
    });
  }

  async remove(key: string): Promise<void> {
    const store = this.forKey(key);
    await store.withCacheLock(async () => {
      const cache = await store.readCache();
      delete cache.tokens[key];
      await store.writeCache(cache);
      fileLogger.debug("removed file credential", {
        credential: credentialId(key),
        layout: this.layout,
      });
    });
  }

  acquireLock(key: string, timeoutMs?: number): Promise<string> {
    return this.locks.acquire(
      this.layout === FileLayout.Single ? `${this.root}:refresh` : `${this.root}:${key}:refresh`,
      timeoutMs,
    );
  }

  releaseLock(lease: string): Promise<void> {
    return this.locks.release(lease);
  }

  name(): string {
    return "file";
  }

  private forKey(key: string): FileCredentialStore {
    if (this.layout === FileLayout.Single) return this;
    const digest = createHash("sha256").update(key).digest("hex");
    return new FileCredentialStore(join(this.root, digest), FileLayout.Single, this.locks);
  }

  private async withCacheLock<T>(action: () => Promise<T>): Promise<T> {
    await ensureDirectory(this.root, 0o700);
    const lease = await this.locks.acquire(`${this.root}:cache`, 30_000);
    try {
      return await action();
    } finally {
      await this.locks.release(lease);
    }
  }

  private async readCache(): Promise<TokenCache> {
    try {
      const source = await readTextFile(join(this.root, "token-cache.json"));
      const cache = source ? (JSON.parse(source) as TokenCache) : { version: 1, tokens: {} };
      if (cache.version !== 1 || typeof cache.tokens !== "object" || !cache.tokens) {
        throw new AuthError("storage", "Token cache must use version 1");
      }
      fileLogger.debug("read token cache", {
        exists: Boolean(source),
        credentialCount: Object.keys(cache.tokens).length,
      });
      return cache;
    } catch (cause) {
      if (cause instanceof AuthError) throw cause;
      throw new AuthError("storage", "Could not read Databricks token cache", { cause });
    }
  }

  private async writeCache(cache: TokenCache): Promise<void> {
    try {
      await atomicWriteTextFile(
        join(this.root, "token-cache.json"),
        `${JSON.stringify(cache, null, 2)}\n`,
        0o600,
      );
      fileLogger.debug("wrote token cache", { credentialCount: Object.keys(cache.tokens).length });
    } catch (cause) {
      throw new AuthError("storage", "Could not write Databricks token cache", { cause });
    }
  }
}

async function ensureDirectory(path: string, mode: number): Promise<void> {
  await mkdir(path, { recursive: true, mode });
  await chmod(path, mode);
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

async function atomicWriteTextFile(path: string, content: string, mode: number): Promise<void> {
  const parent = dirname(path);
  await ensureDirectory(parent, 0o700);
  const temporary = join(parent, `.${basename(path)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause;
    });
  }
}

function serializeToken(token: Token): Record<string, unknown> {
  return {
    access_token: token.accessToken,
    token_type: token.tokenType,
    ...(token.refreshToken ? { refresh_token: token.refreshToken } : {}),
    ...(token.expiry ? { expiry: token.expiry } : {}),
    ...(token.scopes.length ? { scopes: token.scopes } : {}),
  };
}

function deserializeToken(value: unknown): Token | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const accessToken = stringValue(record.access_token ?? record.accessToken);
  if (!accessToken) return undefined;
  return {
    accessToken,
    tokenType: stringValue(record.token_type ?? record.tokenType) ?? "Bearer",
    ...(stringValue(record.refresh_token ?? record.refreshToken)
      ? { refreshToken: stringValue(record.refresh_token ?? record.refreshToken) }
      : {}),
    ...(stringValue(record.expiry ?? record.expires_at)
      ? { expiry: stringValue(record.expiry ?? record.expires_at) }
      : {}),
    scopes: Array.isArray(record.scopes)
      ? record.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
