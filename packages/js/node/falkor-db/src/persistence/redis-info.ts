/**
 * Redis persistence metadata parsing and completed-RDB detection.
 *
 * Reuse this module whenever FalkorDB persistence decisions depend on `INFO
 * persistence`; do not infer snapshot completion from filesystem timestamps
 * alone or trigger `BGSAVE` merely to discover whether the graph changed.
 *
 * @module
 */

import { asyncUtils } from "@dbx-tools/shared-core";

/** Redis persistence fields required by durable snapshot orchestration. */
export interface RedisPersistenceInfo {
  rdbBgSaveInProgress: boolean;
  rdbLastSaveTime: number;
  rdbLastBgSaveStatus: string;
  rdbChangesSinceLastSave: number;
}

/** Minimal Redis client surface used by the persistence manager. */
export interface RedisPersistenceClient {
  info(section: "persistence"): Promise<string>;
  bgSave(): Promise<unknown>;
}

/** Parse the fields used by the backup manager from `INFO persistence`. */
export function parsePersistenceInfo(raw: string): RedisPersistenceInfo {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return {
    rdbBgSaveInProgress: integer(values, "rdb_bgsave_in_progress") !== 0,
    rdbLastSaveTime: integer(values, "rdb_last_save_time"),
    rdbLastBgSaveStatus: values.get("rdb_last_bgsave_status") ?? "unknown",
    rdbChangesSinceLastSave: integer(values, "rdb_changes_since_last_save"),
  };
}

/** Read and parse the current Redis persistence state. */
export async function getPersistenceInfo(
  redis: RedisPersistenceClient,
): Promise<RedisPersistenceInfo> {
  return parsePersistenceInfo(await redis.info("persistence"));
}

/** Wait until a requested background save finishes successfully. */
export async function waitForBackgroundSave(
  redis: RedisPersistenceClient,
  previousSaveTime: number,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<RedisPersistenceInfo> {
  let completed: RedisPersistenceInfo | undefined;
  for await (const info of asyncUtils.poll(() => getPersistenceInfo(redis), {
    intervalMs: options.intervalMs ?? 250,
    timeoutMs: options.timeoutMs ?? 30_000,
    predicate: (value) => {
      if (!value.rdbBgSaveInProgress && value.rdbLastBgSaveStatus !== "ok") {
        throw new Error(`Redis background save failed: ${value.rdbLastBgSaveStatus}`);
      }
      completed = value;
      return value.rdbBgSaveInProgress || value.rdbLastSaveTime <= previousSaveTime;
    },
  })) {
    completed = info;
  }
  if (!completed || completed.rdbLastSaveTime <= previousSaveTime) {
    throw new Error("Redis background save completed without a newer RDB timestamp");
  }
  return completed;
}

function integer(values: ReadonlyMap<string, string>, key: string): number {
  const value = Number.parseInt(values.get(key) ?? "0", 10);
  return Number.isFinite(value) ? value : 0;
}
