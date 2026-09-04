import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { StorageAdapter } from "./runtime.ts";

const TABLE = "dbx_tools_auth_u2m_tokens";
const LOCK_RETRY_MILLIS = 50;

type PgPoolLike = Pick<Pool, "connect" | "query">;
type LockRow = QueryResultRow & { acquired: boolean };
type UnlockRow = QueryResultRow & { released: boolean };

function advisoryLockId(profile: string): bigint {
  return createHash("sha256").update(`dbx-tools-auth-u2m:${profile}`).digest().readBigInt64BE(0);
}

function isUndefinedTable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "42P01";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Create a U2M storage adapter backed by a caller-owned `pg.Pool`. */
export function createStorage(pool: PgPoolLike): StorageAdapter {
  const leases = new Map<string, { client: PoolClient; lockId: bigint }>();

  return {
    async load(profile) {
      try {
        const result = await pool.query<{ token: unknown } & QueryResultRow>(
          `SELECT token FROM ${TABLE} WHERE profile = $1`,
          [profile],
        );
        const token = result.rows[0]?.token;
        return token === undefined ? undefined : JSON.stringify(token);
      } catch (error) {
        if (isUndefinedTable(error)) return undefined;
        throw error;
      }
    },

    async prepareWrite() {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (profile TEXT PRIMARY KEY, token JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      );
    },

    async save(profile, token) {
      await pool.query(
        `INSERT INTO ${TABLE}(profile, token) VALUES ($1, $2::jsonb) ON CONFLICT(profile) DO UPDATE SET token = EXCLUDED.token, updated_at = now()`,
        [profile, token],
      );
    },

    async remove(profile) {
      try {
        await pool.query(`DELETE FROM ${TABLE} WHERE profile = $1`, [profile]);
      } catch (error) {
        if (!isUndefinedTable(error)) throw error;
      }
    },

    async acquireLock(profile, timeoutMillis) {
      const client = await pool.connect();
      const lockId = advisoryLockId(profile);
      const deadline = Date.now() + Number(timeoutMillis);
      try {
        while (true) {
          const result = await client.query<LockRow>(
            "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
            [lockId.toString()],
          );
          if (result.rows[0]?.acquired === true) {
            const lease = randomUUID();
            leases.set(lease, { client, lockId });
            return lease;
          }
          if (Date.now() >= deadline) throw new Error(`timed out locking profile ${profile}`);
          await sleep(LOCK_RETRY_MILLIS);
        }
      } catch (error) {
        client.release(error instanceof Error ? error : undefined);
        throw error;
      }
    },

    async releaseLock(lease) {
      const held = leases.get(lease);
      if (!held) throw new Error(`unknown Postgres storage lease ${lease}`);
      leases.delete(lease);
      let releaseError: Error | undefined;
      try {
        const result = await held.client.query<UnlockRow>(
          "SELECT pg_advisory_unlock($1::bigint) AS released",
          [held.lockId.toString()],
        );
        if (result.rows[0]?.released !== true) {
          throw new Error(`Postgres advisory lock ${held.lockId} was not held by this connection`);
        }
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        held.client.release(releaseError);
      }
    },

    name() {
      return "postgres";
    },
  };
}
