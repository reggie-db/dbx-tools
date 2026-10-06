/**
 * Immutable local RDB staging, hashing, and restore verification.
 *
 * The live `dump.rdb` is always copied before upload so a later Redis rename
 * cannot change the bytes being transferred. Reuse these helpers instead of
 * hashing or uploading the live database file directly.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** Local immutable snapshot metadata. */
export interface LocalSnapshot {
  path: string;
  size: number;
  sha256: string;
}

/** Copy a live RDB into an immutable staging path and hash the copied bytes. */
export async function stageSnapshot(source: string, destination: string): Promise<LocalSnapshot> {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const [details, sha256] = await Promise.all([stat(destination), sha256File(destination)]);
  return { path: destination, size: details.size, sha256 };
}

/** Compute a file's lowercase SHA-256 digest without buffering it in memory. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Fail when a restored snapshot does not match the durable manifest. */
export async function verifySnapshot(path: string, expectedSha256: string): Promise<void> {
  const actual = await sha256File(path);
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(
      `FalkorDB snapshot checksum mismatch: expected ${expectedSha256}, got ${actual}`,
    );
  }
}
