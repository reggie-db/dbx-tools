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
import { object } from "@dbx-tools/shared-core";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

const SIGNED_BIGINT_BITS = 64;

/**
 * What names a lock. Anything reducible to a stable identity: a string, an id, a
 * `["invoice", id]` pair, a config object, or an explicit `bigint` to interoperate
 * with another implementation's published lock id.
 *
 * One value or many: an array is read as multiple parts, anything else as a single
 * part. So `["invoice", 7]` and `"invoice_7"` are different locks, since the
 * canonical form sees different structure.
 */
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

/**
 * Convert an arbitrary structured key into PostgreSQL's signed 64-bit advisory
 * lock namespace. A bigint is preserved directly so callers can interoperate
 * with another implementation that publishes its lock ID.
 *
 * Everything else is canonicalized with `object.toStableKey` and hashed, so key
 * order in an object does not matter while a `1` and a `"1"` stay different locks.
 * A cycle, a non-finite number, or a function/symbol key throws `TypeError`
 * rather than yielding an identity two callers could disagree about.
 */
export function advisoryLockId(key: AdvisoryLockKey): bigint {
  if (typeof key === "bigint") return BigInt.asIntN(SIGNED_BIGINT_BITS, key);
  const parts = object.toOneOrMany(key);
  const digest = createHash("sha256")
    .update(parts.map((part) => object.toStableKey(part)).join("\u0000"))
    .digest();
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
