import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import { createStorage } from "../src/postgres.ts";

type Call = { text: string; values?: unknown[] };

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows } as QueryResult<T>;
}

function fakePool(calls: Call[]) {
  let releases = 0;
  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (text.includes("pg_try_advisory_lock")) return result([{ acquired: true }]);
      if (text.includes("pg_advisory_unlock")) return result([{ released: true }]);
      return result([]);
    },
    release() {
      releases += 1;
    },
  } as unknown as PoolClient;
  const pool = {
    connect: async () => client,
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (text.startsWith("SELECT token")) return result([{ token: { access_token: "token" } }]);
      return result([]);
    },
  } as unknown as Pool;
  return { pool, releases: () => releases };
}

describe("Postgres U2M storage", () => {
  it("loads and saves serialized tokens", async () => {
    const calls: Call[] = [];
    const { pool } = fakePool(calls);
    const storage = createStorage(pool);

    assert.equal(await storage.load("DEFAULT"), JSON.stringify({ access_token: "token" }));
    await storage.prepareWrite();
    await storage.save("DEFAULT", '{"access_token":"next"}');
    await storage.remove("DEFAULT");

    assert.match(calls[0]!.text, /^SELECT token/);
    assert.match(calls[1]!.text, /^CREATE TABLE/);
    assert.deepEqual(calls[2]!.values, ["DEFAULT", '{"access_token":"next"}']);
    assert.match(calls[3]!.text, /^DELETE FROM/);
  });

  it("holds a dedicated client until Rust releases the lease", async () => {
    const calls: Call[] = [];
    const { pool, releases } = fakePool(calls);
    const storage = createStorage(pool);

    const lease = await storage.acquireLock("DEFAULT", 1000n);
    assert.equal(releases(), 0);
    await storage.releaseLock(lease);

    assert.match(calls[0]!.text, /pg_try_advisory_lock/);
    assert.match(calls[1]!.text, /pg_advisory_unlock/);
    assert.equal(calls[0]!.values?.[0], calls[1]!.values?.[0]);
    assert.equal(releases(), 1);
  });
});
