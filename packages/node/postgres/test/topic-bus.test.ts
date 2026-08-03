import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { Notification, QueryResult } from "pg";

import { PostgresTopicBus } from "../src/topic-bus.ts";

class FakeClient extends EventEmitter {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];
  released = false;
  releaseError: Error | undefined;

  async query(text: string, values?: unknown[]): Promise<QueryResult> {
    this.queries.push({ text, values });
    return { rows: [], command: "", rowCount: 0, oid: 0, fields: [] };
  }

  release(error?: Error): void {
    this.released = true;
    this.releaseError = error;
  }
}

function fixture() {
  const client = new FakeClient();
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const pool = {
    connect: async () => client,
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: [], command: "", rowCount: 0, oid: 0, fields: [] } as QueryResult;
    },
  };
  return { client, pool, queries };
}

describe("PostgresTopicBus", () => {
  it("broadcasts an envelope through pg_notify", async () => {
    const { pool, queries } = fixture();
    const bus = new PostgresTopicBus(pool, {
      metadata: { project: "automatic-project", publicIp: "203.0.113.8" },
    });
    const message = await bus.broadcast("orders", {
      type: "order.updated",
      metadata: { project: "caller-project", priority: "high" },
      body: { id: 7 },
    });
    assert.equal(queries[0]?.text, "SELECT pg_notify($1, $2)");
    assert.equal(queries[0]?.values?.[0], "dbx_tools_topic_bus");
    const encoded = JSON.parse(String(queries[0]?.values?.[1]));
    assert.equal(encoded.type, "order.updated");
    assert.deepEqual(encoded.body, { id: 7 });
    assert.equal(encoded.metadata.project, "caller-project");
    assert.equal(encoded.metadata.publicIp, "203.0.113.8");
    assert.equal(encoded.metadata.priority, "high");
    assert.equal(typeof encoded.metadata.hostname, "string");
    assert.equal("arch" in encoded.metadata, false);
    assert.equal("runtime" in encoded.metadata, false);
    assert.equal("runtimeVersion" in encoded.metadata, false);
    assert.equal(message.topic, "orders");
  });

  it("uses one dedicated LISTEN connection and filters by topic", async () => {
    const { client, pool } = fixture();
    const bus = new PostgresTopicBus(pool);
    const received: unknown[] = [];
    const unsubscribe = await bus.listen("orders", (message) => received.push(message.body));
    assert.equal(client.queries[0]?.text, 'LISTEN "dbx_tools_topic_bus"');

    client.emit("notification", {
      channel: "dbx_tools_topic_bus",
      payload: JSON.stringify({
        id: "event-1",
        topic: "orders",
        type: "order.updated",
        metadata: { source: "test" },
        body: { id: 7 },
        publishedAt: new Date().toISOString(),
      }),
    } satisfies Notification);
    client.emit("notification", {
      channel: "dbx_tools_topic_bus",
      payload: JSON.stringify({
        id: "event-2",
        topic: "other",
        type: "order.updated",
        metadata: {},
        body: { id: 8 },
        publishedAt: new Date().toISOString(),
      }),
    } satisfies Notification);
    await Promise.resolve();
    assert.deepEqual(received, [{ id: 7 }]);

    await unsubscribe();
    await bus.close();
    assert.equal(client.queries.at(-1)?.text, 'UNLISTEN "dbx_tools_topic_bus"');
    assert.equal(client.released, true);
  });

  it("rejects invalid channels and oversized notifications", async () => {
    const { pool } = fixture();
    assert.throws(() => new PostgresTopicBus(pool, { channel: "bad-channel" }), TypeError);
    const bus = new PostgresTopicBus(pool);
    await assert.rejects(
      () => bus.broadcast("large", { type: "test.large", body: "x".repeat(8_000) }),
      RangeError,
    );
    await assert.rejects(
      () =>
        bus.broadcast("invalid", {
          type: "test.invalid",
          body: undefined as never,
        }),
      TypeError,
    );
    await assert.rejects(
      () => bus.broadcast("invalid", { type: "test.invalid", body: Number.POSITIVE_INFINITY }),
      TypeError,
    );
  });

  it("reconnects a listener after its dedicated connection fails", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const clients = [first, second];
    const pool = {
      connect: async () => clients.shift()!,
      query: async () => ({ rows: [], command: "", rowCount: 0, oid: 0, fields: [] }),
    };
    const errors: unknown[] = [];
    const received: unknown[] = [];
    const bus = new PostgresTopicBus(pool, { onError: (cause) => errors.push(cause) });
    await bus.listen("orders", (message) => received.push(message.body));

    const connectionError = new Error("connection lost");
    first.emit("error", connectionError);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(first.released, true);
    assert.equal(first.releaseError, connectionError);
    assert.equal(second.queries[0]?.text, 'LISTEN "dbx_tools_topic_bus"');
    second.emit("notification", {
      channel: "dbx_tools_topic_bus",
      payload: JSON.stringify({
        id: "event-reconnected",
        topic: "orders",
        type: "order.updated",
        metadata: {},
        body: { id: 9 },
        publishedAt: new Date().toISOString(),
      }),
    } satisfies Notification);
    await Promise.resolve();
    assert.deepEqual(received, [{ id: 9 }]);
    assert.deepEqual(errors, [connectionError]);
    await bus.close();
  });
});
