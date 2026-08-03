/**
 * Advisory-lock helpers for any `pg.Pool`-compatible pool.
 *
 * PostgreSQL advisory locks belong to a connection, not a pool. These helpers
 * reserve one pooled client for the full callback, acquire the lock on that
 * client, and release both in the correct order.
 *
 * @module
 */

import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

const SIGNED_BIGINT_BITS = 64;

/** Any value that can be reduced to a stable advisory-lock identity. */
export type AdvisoryLockKey = unknown;

/** Structural pool shape accepted by the lock helpers. */
export type PgPoolLike = Pick<Pool, "connect">;

/** Structural query shape shared by `pg.PoolClient` and AppKit Lakebase. */
export interface PgQueryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}

type UnlockRow = QueryResultRow & { unlocked: boolean };

function stableKey(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return `string:${value.length}:${value}`;
    case "boolean":
      return `boolean:${value}`;
    case "bigint":
      return `bigint:${value}`;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Advisory lock numbers must be finite");
      return `number:${Object.is(value, -0) ? "-0" : value}`;
    case "undefined":
      return "undefined";
    case "object": {
      if (seen.has(value)) throw new TypeError("Advisory lock keys cannot contain cycles");
      seen.add(value);
      try {
        if (value instanceof Date) return `date:${value.toISOString()}`;
        if (Array.isArray(value)) {
          return `array:[${value.map((item) => stableKey(item, seen)).join(",")}]`;
        }
        const record = value as Record<string, unknown>;
        return `object:{${Object.keys(record)
          .sort()
          .map((key) => `${stableKey(key, seen)}=${stableKey(record[key], seen)}`)
          .join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new TypeError(`Unsupported advisory lock key type: ${typeof value}`);
  }
}

/**
 * Convert an arbitrary structured key into PostgreSQL's signed 64-bit advisory
 * lock namespace. A bigint is preserved directly so callers can interoperate
 * with another implementation that publishes its lock ID.
 */
export function advisoryLockId(key: AdvisoryLockKey): bigint {
  if (typeof key === "bigint") return BigInt.asIntN(SIGNED_BIGINT_BITS, key);
  const digest = createHash("sha256").update(stableKey(key)).digest();
  return digest.readBigInt64BE(0);
}

async function acquire(client: PgQueryable, id: bigint, transaction: boolean): Promise<void> {
  const fn = transaction ? "pg_advisory_xact_lock" : "pg_advisory_lock";
  await client.query(`SELECT ${fn}($1::bigint)`, [id.toString()]);
}

async function unlock(client: PgQueryable, id: bigint): Promise<void> {
  const result = await client.query<UnlockRow>(
    "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
    [id.toString()],
  );
  if (result.rows[0]?.unlocked !== true) {
    throw new Error(`Postgres advisory lock ${id} was not held by this connection`);
  }
}

/**
 * Hold a session advisory lock for the duration of `fn`.
 *
 * The callback receives the dedicated `PoolClient` that owns the lock. Use it
 * for any operation that must be protected by the lock.
 */
export async function withAdvisoryLock<T>(
  pool: PgPoolLike,
  key: AdvisoryLockKey,
  fn: (client: PoolClient) => Promise<T> | T,
): Promise<T> {
  const id = advisoryLockId(key);
  const client = await pool.connect();
  let acquired = false;
  let failed = false;
  let failure: unknown;
  let value: T | undefined;

  try {
    await acquire(client, id, false);
    acquired = true;
    value = await fn(client);
  } catch (error) {
    failed = true;
    failure = error;
  }

  let unlockFailure: unknown;
  if (acquired) {
    try {
      await unlock(client, id);
    } catch (error) {
      unlockFailure = error;
    }
  }
  client.release(unlockFailure instanceof Error ? unlockFailure : undefined);

  if (failed) throw failure;
  if (unlockFailure !== undefined) throw unlockFailure;
  return value as T;
}

/**
 * Run `fn` in a transaction while holding a transaction advisory lock.
 *
 * The lock is released atomically by `COMMIT` or `ROLLBACK`, making this the
 * right primitive for one-time schema installation and migrations.
 */
export async function withAdvisoryTransactionLock<T>(
  pool: PgPoolLike,
  key: AdvisoryLockKey,
  fn: (client: PoolClient) => Promise<T> | T,
): Promise<T> {
  const id = advisoryLockId(key);
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    await acquire(client, id, true);
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError =
        rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
