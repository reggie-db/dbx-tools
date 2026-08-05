/**
 * Persisted-bus behavior: the two notification payload styles, TTL coercion, the
 * history cursor, and the grants a managed installation needs.
 *
 * The pool here is a fake that records SQL and answers the two reads persistence
 * performs (`RETURNING sequence` on insert, and the pointer's envelope lookup), so
 * the shape of what is written and read is asserted without a live Postgres.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { Notification, QueryResult } from "pg";

import {
  decodePointer,
  messageBusGrantStatements,
  resolvePersistenceOptions,
  ttlMilliseconds,
} from "../src/persistence.ts";
import { PostgresTopicBus } from "../src/topic-bus.ts";

type Rows = Record<string, unknown>[];

class FakeClient extends EventEmitter {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];
  released = false;
  constructor(private readonly answer: (text: string) => Rows = () => []) {
    super();
  }
  async query(text: string, values?: unknown[]): Promise<QueryResult> {
    this.queries.push({ text, values });
    const rows = this.answer(text);
    return { rows, command: "", rowCount: rows.length, oid: 0, fields: [] } as QueryResult;
  }
  release(): void {
    this.released = true;
  }
}

function fixture(answer: (text: string) => Rows = () => []) {
  const listenClient = new FakeClient(answer);
  const clients: FakeClient[] = [];
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const pool = {
    connect: async () => {
      const client = clients.length === 0 ? listenClient : new FakeClient(answer);
      clients.push(client);
      return client;
    },
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      const rows = answer(text);
      return { rows, command: "", rowCount: rows.length, oid: 0, fields: [] } as QueryResult;
    },
  };
  return { pool, queries, clients, listenClient };
}

/** The SQL a persisted publish ran, across the pool and its checked-out clients. */
function sql(fix: ReturnType<typeof fixture>): string[] {
  return [...fix.queries, ...fix.clients.flatMap((client) => client.queries)].map(
    (entry) => entry.text,
  );
}

describe("persistence options", () => {
  it("defaults to an open tier, a 24 hour TTL, and self-provisioning", () => {
    const options = resolvePersistenceOptions(true);
    assert.equal(options.schema, "dbx_message_bus");
    assert.equal(options.scope, "open");
    assert.equal(options.payload, "envelope");
    assert.equal(options.ttl, "24 hours");
    assert.equal(options.provision, true);
    assert.equal(ttlMilliseconds(options.ttl), 24 * 60 * 60 * 1000);
  });

  it("treats a disabled TTL as opt-in, not as the default", () => {
    assert.equal(ttlMilliseconds(resolvePersistenceOptions({ ttl: false }).ttl), null);
    assert.equal(ttlMilliseconds(resolvePersistenceOptions({ ttl: "30s" }).ttl), 30_000);
    // A TTL that cannot be read as a duration is a configuration mistake, not a
    // silent "never expires" - that difference is unbounded table growth.
    assert.throws(() => ttlMilliseconds("soon" as never), TypeError);
    assert.throws(() => ttlMilliseconds(0), TypeError);
    assert.throws(() => resolvePersistenceOptions({ scope: "public" as never }), TypeError);
  });

  it("grants only the selected tier's table", () => {
    const options = resolvePersistenceOptions({ scope: "restricted" });
    const statements = messageBusGrantStatements("readers", "restricted", options).join("\n");
    assert.match(statements, /GRANT USAGE ON SCHEMA "dbx_message_bus" TO "readers"/);
    assert.match(statements, /ON TABLE "dbx_message_bus"\."restricted_messages" TO "readers"/);
    assert.equal(statements.includes("open_messages"), false);
  });
});

describe("PostgresTopicBus persistence", () => {
  it("stores the envelope and notifies in one transaction", async () => {
    const fix = fixture((text) => (text.includes("INSERT INTO") ? [{ sequence: "12" }] : []));
    const bus = new PostgresTopicBus(fix.pool, { persist: true });
    await bus.broadcast("orders", { type: "order.updated", body: { id: 7 } });

    const statements = sql(fix);
    assert.ok(statements.some((text) => text.includes("CREATE SCHEMA IF NOT EXISTS")));
    assert.ok(statements.includes("BEGIN"));
    assert.ok(statements.includes("COMMIT"));
    const insert = statements.findIndex((text) => text.includes("INSERT INTO"));
    const notify = statements.findIndex((text) => text.includes("pg_notify"));
    // Insert BEFORE notify, inside the transaction: `NOTIFY` is delivered at
    // COMMIT, so a listener can never see a pointer to an unreadable row.
    assert.ok(insert >= 0 && notify > insert);
    // The default payload is the whole envelope, so a listener needs no read.
    const payload = [...fix.clients.flatMap((client) => client.queries)].find((entry) =>
      entry.text.includes("pg_notify"),
    )?.values?.[1];
    assert.equal(JSON.parse(String(payload)).body.id, 7);
  });

  it("sends a pointer instead of the envelope, lifting the NOTIFY size limit", async () => {
    const fix = fixture((text) => (text.includes("INSERT INTO") ? [{ sequence: "12" }] : []));
    const bus = new PostgresTopicBus(fix.pool, { persist: { payload: "pointer" } });
    // Larger than the 7900-byte envelope cap, which only a pointer can carry.
    await bus.broadcast("orders", { type: "order.large", body: "x".repeat(9_000) });

    const payload = fix.clients
      .flatMap((client) => client.queries)
      .find((entry) => entry.text.includes("pg_notify"))?.values?.[1];
    const pointer = decodePointer(String(payload));
    assert.deepEqual(pointer, { scope: "open", topic: "orders", id: pointer!.id, sequence: "12" });
    // Routing and identity only: the body never reaches the notification, which is
    // what lets a listener without the table grant learn nothing but "something
    // happened".
    assert.equal(String(payload).includes("xxxx"), false);
  });

  it("still enforces the envelope size limit when persistence is off or envelope-mode", async () => {
    const fix = fixture((text) => (text.includes("INSERT INTO") ? [{ sequence: "1" }] : []));
    const bus = new PostgresTopicBus(fix.pool, { persist: true });
    await assert.rejects(
      () => bus.broadcast("orders", { type: "order.large", body: "x".repeat(9_000) }),
      RangeError,
    );
  });

  it("reads the envelope back when a pointer arrives", async () => {
    const stored = {
      id: "event-1",
      topic: "orders",
      type: "order.updated",
      metadata: {},
      body: { id: 7 },
      publishedAt: new Date().toISOString(),
    };
    const fix = fixture((text) =>
      text.startsWith("SELECT envelope") ? [{ envelope: stored }] : [],
    );
    const bus = new PostgresTopicBus(fix.pool, { persist: { payload: "pointer" } });
    const received: unknown[] = [];
    await bus.listen("orders", (message) => received.push(message.body));

    fix.listenClient.emit("notification", {
      channel: bus.channelName,
      payload: JSON.stringify({
        v: 1,
        scope: "open",
        topic: "orders",
        id: "event-1",
        sequence: "12",
      }),
    } satisfies Notification);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(received, [{ id: 7 }]);
    await bus.close();
  });

  it("ignores a pointer for an unknown version or a foreign payload", () => {
    assert.equal(decodePointer(undefined), undefined);
    assert.equal(decodePointer("not json"), undefined);
    assert.equal(
      decodePointer(JSON.stringify({ v: 2, scope: "open", topic: "t", id: "a", sequence: "1" })),
      undefined,
    );
    assert.equal(
      decodePointer(JSON.stringify({ v: 1, scope: "other", topic: "t", id: "a", sequence: "1" })),
      undefined,
    );
    assert.equal(
      decodePointer(JSON.stringify({ v: 1, scope: "open", topic: "t", id: "a", sequence: 1 })),
      undefined,
    );
  });

  it("pages history by an opaque cursor bound to its tier", async () => {
    const rows = [
      { sequence: "5", expires_at: null, envelope: { id: "a", topic: "orders" } },
      { sequence: "6", expires_at: null, envelope: { id: "b", topic: "orders" } },
    ];
    const fix = fixture((text) => (text.startsWith("SELECT sequence") ? rows : []));
    const bus = new PostgresTopicBus(fix.pool, { persist: true });
    const page = await bus.history("orders", { limit: 2 });
    assert.equal(page.messages.length, 2);
    assert.equal(page.nextCursor, page.messages[1]?.cursor);

    // A full page hands back a cursor; the cursor is opaque and only valid for the
    // tier it came from, so a restricted read cannot resume an open one.
    await assert.rejects(
      () => bus.history("orders", { after: page.nextCursor, scope: "restricted" }),
      TypeError,
    );
  });

  it("refuses history and cleanup when persistence is disabled", async () => {
    const fix = fixture();
    const bus = new PostgresTopicBus(fix.pool);
    await assert.rejects(() => bus.history("orders"), /persistence is disabled/);
    await assert.rejects(() => bus.cleanupExpired(), /persistence is disabled/);
  });
});
