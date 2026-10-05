/**
 * Cross-runtime Postgres lock and channel identity policy.
 *
 * @module
 */

import { createHash } from "node:crypto";

import {
  LakebaseConnectionInputs,
  parseAddress as parseLakebaseAddress,
  parseResourcePath as parseLakebaseResourcePath,
  parseSslMode as parseLakebaseSslMode,
  SslMode,
} from "@dbx-tools/lakebase/address";
import * as hash from "@dbx-tools/shared-core/hash";
import * as object from "@dbx-tools/shared-core/object";
import * as stringUtils from "@dbx-tools/shared-core/string-utils";

const SIGNED_BIGINT_BITS = 64;
const MAX_CHANNEL_LENGTH = 63;
const CHANNEL_HASH_LENGTH = 6;
const CHANNEL_FALLBACK = "bus";

/** Convert a structured key into a JSON-safe signed 64-bit lock identifier. */
export function advisoryLockId(key: unknown, explicit = false): string {
  return resolveAdvisoryLockId(explicit ? BigInt(String(key)) : key).toString();
}

function resolveAdvisoryLockId(key: unknown): bigint {
  if (typeof key === "bigint") return BigInt.asIntN(SIGNED_BIGINT_BITS, key);
  const parts = object.toOneOrMany(key);
  const digest = createHash("sha256");
  parts.forEach((part, index) => {
    if (index > 0) digest.update(Buffer.from([0]));
    digest.update(object.toStableKey(part), "utf8");
  });
  return digest.digest().readBigInt64BE(0);
}

/** Derive a legal deterministic Postgres channel name from structured input. */
export function channelName(value: unknown): string {
  const parts = object.toOneOrMany(value);
  const suffix = hash.fnvHashWithOptions(
    { length: CHANNEL_HASH_LENGTH },
    parts.map((part) => object.toStableKey(part)).join("\u0000"),
  );
  const labelled = parts.filter((part) => {
    const type = typeof part;
    return type === "string" || type === "number" || type === "boolean" || type === "bigint";
  });
  const body = stringUtils
    .toIdentifierWithOptions({ delimiter: "_" }, ...labelled)
    .slice(0, MAX_CHANNEL_LENGTH - suffix.length - 1)
    .replace(/_+$/, "");
  const prefix = /^[A-Za-z_]/.test(body) ? body : `${CHANNEL_FALLBACK}_${body}`;
  return `${prefix}_${suffix}`.replace(/_+/g, "_");
}

/** Parse a PostgreSQL URL, Lakebase resource path, hostname, or project ID. */
export function parseAddress(input: string | null | undefined): LakebaseConnectionInputs {
  return parseLakebaseAddress(input);
}

/** Parse a canonical Lakebase project, branch, endpoint, or database path. */
export function parseResourcePath(input: string | null | undefined): LakebaseConnectionInputs {
  return parseLakebaseResourcePath(input);
}

/** Parse a supported PostgreSQL SSL mode. */
export function parseSslMode(input: string | null | undefined): SslMode | undefined {
  return parseLakebaseSslMode(input);
}
