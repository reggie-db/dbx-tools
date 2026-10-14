import { CacheManager } from "@databricks/appkit";
import { LakeboxApiError, type LakeboxEntry } from "@dbx-tools/lakebox/rest";
import { withAdvisoryLock, type PgPoolLike } from "@dbx-tools/postgres";
import { log } from "@dbx-tools/shared-core";
import { z } from "zod";

const CACHE_NAMESPACE = "appkit-lakebox:resource";
const RESOURCE_TTL_SECONDS = 365 * 24 * 60 * 60;
const LEGACY_PREFIX = "dbx-lakebox-";
const logger = log.logger("appkit-lakebox:resource");

const LakeboxResourceReferenceSchema = z
  .object({ sandboxId: z.string().min(1).describe("Databricks Lakebox identifier.") })
  .strict()
  .describe("Persistent pointer to the Databricks-assigned app Lakebox.");

interface ResourceCache {
  generateKey(parts: (string | number | object)[], userKey: string): string;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, options?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Lakebox client capabilities required by the persistent resource registry. */
export interface LakeboxResourceClient {
  workspaceScope(): Promise<string>;
  list(signal?: AbortSignal): Promise<LakeboxEntry[]>;
  get(id: string, signal?: AbortSignal): Promise<LakeboxEntry>;
  create(signal?: AbortSignal): Promise<LakeboxEntry>;
  delete(id: string, signal?: AbortSignal): Promise<void>;
}

/**
 * Persists the Databricks-assigned Lakebox ID and serializes first creation
 * across app replicas with the Lakebase service-principal pool.
 */
export class LakeboxResourceRegistry {
  private readonly pending = new Map<string, Promise<LakeboxEntry>>();
  private readonly legacyChecked = new Set<string>();

  constructor(
    private readonly application: string,
    private readonly pool?: PgPoolLike,
    private readonly cache = (): ResourceCache => CacheManager.getInstanceSync(),
  ) {}

  /** Resolves the current app Lakebox without creating one. */
  async read(
    client: LakeboxResourceClient,
    signal?: AbortSignal,
  ): Promise<LakeboxEntry | undefined> {
    const scope = await client.workspaceScope();
    return this.resolve(client, scope, signal);
  }

  /** Returns the current app Lakebox or creates one with a Databricks-assigned name. */
  async getOrCreate(client: LakeboxResourceClient, signal?: AbortSignal): Promise<LakeboxEntry> {
    const scope = await client.workspaceScope();
    const current = this.pending.get(scope);
    if (current) return current;
    const pending = this.withLock(scope, async () => {
      const existing = await this.resolve(client, scope, signal);
      if (existing) return existing;
      const created = await client.create(signal);
      try {
        await this.write(scope, created.sandboxId);
      } catch (error) {
        await client.delete(created.sandboxId, signal).catch(() => undefined);
        throw error;
      }
      logger.info("created app Lakebox", { id: created.sandboxId });
      return created;
    }).finally(() => this.pending.delete(scope));
    this.pending.set(scope, pending);
    return pending;
  }

  /** Clears the persisted pointer after the managed Lakebox is deleted. */
  async clear(client: LakeboxResourceClient): Promise<void> {
    const scope = await client.workspaceScope();
    await this.cache().delete(this.key(scope));
    this.legacyChecked.add(scope);
  }

  private async resolve(
    client: LakeboxResourceClient,
    scope: string,
    signal?: AbortSignal,
  ): Promise<LakeboxEntry | undefined> {
    const key = this.key(scope);
    const value = await this.cache().get<unknown>(key);
    const parsed = LakeboxResourceReferenceSchema.safeParse(value);
    if (value !== null && !parsed.success) {
      logger.warn("discarded invalid cached Lakebox resource reference", {
        application: this.application,
      });
      await this.cache().delete(key);
    }
    if (parsed.success) {
      try {
        return await client.get(parsed.data.sandboxId, signal);
      } catch (error) {
        if (!(error instanceof LakeboxApiError) || error.status !== 404) throw error;
        await this.cache().delete(key);
        this.legacyChecked.add(scope);
        return undefined;
      }
    }
    if (this.legacyChecked.has(scope)) return undefined;
    this.legacyChecked.add(scope);
    const legacy = selectLegacyLakebox(
      await client.list(signal),
      legacyLakeboxName(this.application),
    );
    if (!legacy) return undefined;
    await this.write(scope, legacy.sandboxId);
    logger.info("adopted legacy named app Lakebox", { id: legacy.sandboxId });
    return legacy;
  }

  private async write(scope: string, sandboxId: string): Promise<void> {
    await this.cache().set(this.key(scope), LakeboxResourceReferenceSchema.parse({ sandboxId }), {
      ttl: RESOURCE_TTL_SECONDS,
    });
  }

  private key(scope: string): string {
    return this.cache().generateKey([CACHE_NAMESPACE, this.application], scope);
  }

  private withLock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    if (!this.pool) return fn();
    return withAdvisoryLock(this.pool, [CACHE_NAMESPACE, this.application, scope], fn);
  }
}

function legacyLakeboxName(application: string): string {
  const slug = application
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 200);
  if (!slug) throw new Error("A managed Lakebox requires a non-empty application key");
  return `${LEGACY_PREFIX}${slug}`;
}

function selectLegacyLakebox(
  entries: readonly LakeboxEntry[],
  name: string,
): LakeboxEntry | undefined {
  return entries
    .filter((entry) => entry.name === name)
    .sort(
      (left, right) =>
        (Date.parse(left.createTime ?? "") || Number.MAX_SAFE_INTEGER) -
          (Date.parse(right.createTime ?? "") || Number.MAX_SAFE_INTEGER) ||
        left.sandboxId.localeCompare(right.sandboxId),
    )[0];
}
