import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { acquireFileLock, type FileLockLease } from "@dbx-tools/core/file-lock";

import { authLogger, credentialId, tokenMetadata } from "./_logging.ts";
import { AuthError } from "./errors.ts";
import type { CredentialStore, LockAdapter, Token } from "./types.ts";
import { FileLayout } from "./types.ts";

const logger = authLogger("file-storage");

interface TokenCache {
  version: number;
  tokens: Record<string, unknown>;
}

class FileLocks implements LockAdapter {
  private readonly leases = new Map<string, FileLockLease>();

  constructor(private readonly lockDirectory: string) {}

  async acquire(key: string, timeoutMs?: number): Promise<string> {
    logger.debug("waiting for file lock", {
      credential: credentialId(key),
      timeoutMs,
    });
    const lease = await acquireFileLock(key, { dir: this.lockDirectory, timeoutMs });
    const id = randomUUID();
    this.leases.set(id, lease);
    logger.debug("file lock acquired", {
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
    logger.debug("file lock released", { backend: lease.backend });
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
      logger.debug("loaded file credential", {
        credential: credentialId(key),
        layout: this.layout,
        token: tokenMetadata(token),
      });
      return token;
    });
  }

  async prepareWrite(): Promise<void> {
    await ensureDirectory(this.root, 0o700);
    logger.debug("prepared credential directory", { layout: this.layout });
  }

  async save(key: string, token: Token): Promise<void> {
    const store = this.forKey(key);
    await store.withCacheLock(async () => {
      const cache = await store.readCache();
      cache.tokens[key] = serializeToken(token);
      await store.writeCache(cache);
      logger.debug("saved file credential", {
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
      logger.debug("removed file credential", {
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
      logger.debug("read token cache", {
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
      logger.debug("wrote token cache", { credentialCount: Object.keys(cache.tokens).length });
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
