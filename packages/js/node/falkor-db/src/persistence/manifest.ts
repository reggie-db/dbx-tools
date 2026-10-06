/**
 * Durable snapshot manifest naming, validation, sequencing, and retention.
 *
 * `latest.json` is updated only after its immutable snapshot exists. Reuse this
 * module for manifest policy so restore and cleanup cannot disagree about the
 * current good snapshot.
 *
 * @module
 */

import { posix } from "node:path";
import type { VolumeStorage } from "./volume.ts";

/** Durable pointer updated only after a complete immutable snapshot upload. */
export const LATEST_MANIFEST_PATH = "latest.json";

/** Directory containing immutable, monotonically sequenced RDB files. */
export const SNAPSHOT_DIRECTORY = "snapshots";

/** Durable pointer to one verified immutable RDB snapshot. */
export interface SnapshotManifest {
  snapshot: string;
  createdAt: string;
  size: number;
  sha256: string;
  sequence: number;
  /** Redis `rdb_last_save_time` represented by this snapshot. */
  redisSaveTime?: number;
}

/** Parse an untrusted manifest read from durable storage. */
export function parseSnapshotManifest(value: unknown): SnapshotManifest {
  if (!isRecord(value)) throw new TypeError("FalkorDB latest.json must be an object");
  const manifest: SnapshotManifest = {
    snapshot: requiredString(value.snapshot, "snapshot"),
    createdAt: requiredString(value.createdAt, "createdAt"),
    size: nonNegativeInteger(value.size, "size"),
    sha256: requiredString(value.sha256, "sha256").toLowerCase(),
    sequence: positiveInteger(value.sequence, "sequence"),
    ...(value.redisSaveTime === undefined
      ? {}
      : { redisSaveTime: nonNegativeInteger(value.redisSaveTime, "redisSaveTime") }),
  };
  if (!manifest.snapshot.startsWith(`${SNAPSHOT_DIRECTORY}/`)) {
    throw new TypeError("FalkorDB manifest snapshot must be under snapshots/");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new TypeError("FalkorDB manifest sha256 must be a 64-character hex digest");
  }
  if (!Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new TypeError("FalkorDB manifest createdAt must be an ISO date");
  }
  return manifest;
}

/** Remote path for an immutable, monotonically sequenced RDB snapshot. */
export function snapshotPath(sequence: number): string {
  return posix.join(SNAPSHOT_DIRECTORY, `${String(sequence).padStart(8, "0")}.rdb`);
}

/** Choose a sequence above both the manifest and any orphaned uploads. */
export async function nextSnapshotSequence(
  storage: VolumeStorage,
  manifest?: SnapshotManifest,
): Promise<number> {
  const entries = await storage.list(SNAPSHOT_DIRECTORY);
  let maximum = manifest?.sequence ?? 0;
  for (const entry of entries) {
    const match = /^(\d+)\.rdb$/.exec(entry.name);
    if (match) maximum = Math.max(maximum, Number.parseInt(match[1]!, 10));
  }
  return maximum + 1;
}

/** Delete old immutable snapshots while preserving the manifest target. */
export async function enforceRetention(
  storage: VolumeStorage,
  manifest: SnapshotManifest,
  retain: number,
): Promise<void> {
  const snapshots = (await storage.list(SNAPSHOT_DIRECTORY))
    .map((entry) => ({ entry, match: /^(\d+)\.rdb$/.exec(entry.name) }))
    .filter((item): item is typeof item & { match: RegExpExecArray } => item.match !== null)
    .map(({ entry, match }) => ({ entry, sequence: Number.parseInt(match[1]!, 10) }))
    .sort((left, right) => right.sequence - left.sequence);
  const keep = new Set(snapshots.slice(0, Math.max(1, retain)).map(({ entry }) => entry.path));
  keep.add(manifest.snapshot);
  for (const { entry } of snapshots) {
    if (!keep.has(entry.path)) await storage.delete(entry.path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a string`);
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = nonNegativeInteger(value, name);
  if (parsed < 1) throw new TypeError(`${name} must be positive`);
  return parsed;
}
