import { CacheManager } from "@databricks/appkit";
import { log, toError } from "@dbx-tools/shared-core";
import { z } from "zod";
import { LakeboxControllerDefinitionSchema, type LakeboxControllerService } from "./services.ts";

const CACHE_NAMESPACE = "appkit-lakebox:service-snapshot";
const SNAPSHOT_TTL_SECONDS = 365 * 24 * 60 * 60;
const logger = log.logger("appkit-lakebox:service-snapshot");

export const LakeboxServiceSnapshotSchema = z
  .object({
    observedAt: z.string().datetime().describe("Time the controller last returned this list."),
    definitions: z
      .array(LakeboxControllerDefinitionSchema)
      .describe("Last observed saved service definitions; never authoritative live state."),
  })
  .strict()
  .describe("Best-effort last-known Lakebox service definitions for an unavailable machine.");

export type LakeboxServiceSnapshot = z.infer<typeof LakeboxServiceSnapshotSchema>;

/** Projects saved definitions into explicitly non-live stopped service records. */
export function stoppedSnapshotServices(
  snapshot: LakeboxServiceSnapshot,
): Map<string, LakeboxControllerService> {
  return new Map(
    snapshot.definitions.map((definition) => [
      definition.name,
      { name: definition.name, state: "stopped", definition },
    ]),
  );
}

interface SnapshotCache {
  generateKey(parts: (string | number | object)[], userKey: string): string;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, options?: { ttl?: number }): Promise<void>;
}

/** Best-effort persistent snapshots backed by AppKit's configured cache. */
export class LakeboxServiceSnapshots {
  constructor(private readonly cache = (): SnapshotCache => CacheManager.getInstanceSync()) {}

  async read(lakeboxId: string, userHash: string): Promise<LakeboxServiceSnapshot | undefined> {
    try {
      const value = await this.cache().get<unknown>(this.key(lakeboxId, userHash));
      if (value === null) return undefined;
      const parsed = LakeboxServiceSnapshotSchema.safeParse(value);
      if (parsed.success) return parsed.data;
      logger.warn("ignored invalid cached service snapshot", { lakeboxId, userHash });
    } catch (error) {
      logger.warn("unable to read cached service snapshot", {
        lakeboxId,
        userHash,
        error: toError(error),
      });
    }
    return undefined;
  }

  async write(
    lakeboxId: string,
    userHash: string,
    snapshot: LakeboxServiceSnapshot,
  ): Promise<void> {
    try {
      await this.cache().set(
        this.key(lakeboxId, userHash),
        LakeboxServiceSnapshotSchema.parse(snapshot),
        { ttl: SNAPSHOT_TTL_SECONDS },
      );
    } catch (error) {
      logger.warn("unable to cache service snapshot", {
        lakeboxId,
        userHash,
        error: toError(error),
      });
    }
  }

  private key(lakeboxId: string, userHash: string): string {
    return this.cache().generateKey([CACHE_NAMESPACE, lakeboxId], userHash);
  }
}
