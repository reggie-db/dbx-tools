/**
 * Advisory-lock helpers for any `pg.Pool`-compatible pool.
 *
 * PostgreSQL advisory locks belong to a connection, not a pool. These helpers
 * reserve one pooled client for the full callback, acquire the lock on that
 * client, and release both in the correct order.
 *
 * @module
 */

import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import { advisoryLockId } from "./identity.ts";

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
  const id = BigInt(advisoryLockId(key));
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
  const id = BigInt(advisoryLockId(key));
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
