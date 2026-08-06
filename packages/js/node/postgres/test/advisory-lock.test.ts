import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { polygotTest } from "@dbx-tools/test-polyglot/polyglot";
import type { PoolClient, QueryResult } from "pg";

import {
  advisoryLockId,
  withAdvisoryLock,
  withAdvisoryTransactionLock,
} from "../src/advisory-lock.ts";

type Call = { text: string; values?: unknown[] };

function fakePool(calls: Call[], options: { fail?: string } = {}) {
  let releases = 0;
  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (options.fail && text.includes(options.fail)) throw new Error(`failed: ${options.fail}`);
      return {
        rows: text.includes("pg_advisory_unlock") ? [{ unlocked: true }] : [],
      } as unknown as QueryResult;
    },
    release() {
      releases += 1;
    },
  } as unknown as PoolClient;
  return {
    pool: { connect: async () => client },
    client,
    releases: () => releases,
  };
}

await polygotTest(
  () => import("../index.ts"),
  "advisoryLock",
  (implementation, language) => {
    describe(`advisoryLockId (${language})`, () => {
      it("hashes string and structured keys to signed int64 ids", () => {
        assert.equal(implementation.advisoryLockId("schema-install"), 8391191540082855336n);
        assert.equal(
          implementation.advisoryLockId(["schema-install", "v2"]),
          -6627415645816226415n,
        );
        assert.equal(implementation.advisoryLockId({ b: 2, a: 1 }), 8289569017560903448n);
        assert.equal(implementation.advisoryLockId(["unicode", "λ"]), 5028212226534770301n);
        assert.equal(implementation.advisoryLockId([1, "1", true, null]), 1977673129255614398n);
      });
    });
  },
);

describe("advisoryLockId TypeScript", () => {
  it("is stable across object key order", () => {
    assert.equal(
      advisoryLockId({ app: "bus", shard: 2 }),
      advisoryLockId({ shard: 2, app: "bus" }),
    );
  });

  it("preserves published bigint lock identifiers", () => {
    assert.equal(advisoryLockId(-9223372036854771659n), -9223372036854771659n);
  });
});

describe("withAdvisoryLock", () => {
  it("holds and releases the lock on the callback client", async () => {
    const calls: Call[] = [];
    const { pool, client, releases } = fakePool(calls);

    const value = await withAdvisoryLock(pool, ["jobs", 42], async (lockedClient) => {
      assert.equal(lockedClient, client);
      calls.push({ text: "callback" });
      return "done";
    });

    assert.equal(value, "done");
    assert.match(calls[0]!.text, /pg_advisory_lock/);
    assert.equal(calls[1]!.text, "callback");
    assert.match(calls[2]!.text, /pg_advisory_unlock/);
    assert.equal(releases(), 1);
  });
});

describe("withAdvisoryTransactionLock", () => {
  it("commits after the protected callback", async () => {
    const calls: Call[] = [];
    const { pool, releases } = fakePool(calls);

    await withAdvisoryTransactionLock(pool, "schema", async () => {
      calls.push({ text: "install" });
    });

    assert.deepEqual(
      calls.map(({ text }) => text),
      ["BEGIN", "SELECT pg_advisory_xact_lock($1::bigint)", "install", "COMMIT"],
    );
    assert.equal(releases(), 1);
  });

  it("rolls back when the callback fails", async () => {
    const calls: Call[] = [];
    const { pool, releases } = fakePool(calls);

    await assert.rejects(
      withAdvisoryTransactionLock(pool, "schema", () => {
        throw new Error("install failed");
      }),
      /install failed/,
    );

    assert.equal(calls.at(-1)?.text, "ROLLBACK");
    assert.equal(releases(), 1);
  });
});
