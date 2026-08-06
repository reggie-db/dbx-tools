import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { polygotTest } from "@dbx-tools/test-polyglot/polyglot";
import type { Notification, QueryResult } from "pg";

import { PACKAGE_IDENTIFIER } from "../index.ts";
import { PostgresTopicBus } from "../src/topic-bus.ts";
import { topicBusConstants } from "./support/topic-bus-source.ts";

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

await polygotTest(
  () => import("../index.ts"),
  "topicBus",
  (implementation, language) => {
    describe(`channelName (${language})`, () => {
      it("keeps default, scalar, parts, and structured identities compatible", () => {
        assert.equal(
          implementation.channelName("dbx_tools_topic_bus"),
          "dbx_tools_topic_bus_3kj9bt",
        );
        assert.equal(implementation.channelName("billing"), "billing_1m8m64");
        assert.equal(implementation.channelName(["billing", "prod"]), "billing_prod_091p2g");
        assert.equal(implementation.channelName("billing_prod"), "billing_prod_3er7fp");
        assert.equal(implementation.channelName({ a: 1 }), "bus_0xnqsa");
      });

      it("keeps collapsed spellings and part structure distinct", () => {
        const collapsed = new Set(
          ["my-app", "my_app", "myApp"].map((value) => implementation.channelName(value)),
        );
        assert.equal(collapsed.size, 3);
        assert.notEqual(
          implementation.channelName(["billing", "prod"]),
          implementation.channelName("billing_prod"),
        );
      });

      it("always emits a legal Postgres identifier", () => {
        for (const value of ["!!!", "", 42, null, "a".repeat(200)]) {
          const name = implementation.channelName(value);
          assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/, `not an identifier: ${name}`);
          assert.ok(name.length <= 63, `too long: ${name}`);
        }
      });
    });
  },
);

await polygotTest(
  async () => ({ PACKAGE_IDENTIFIER, topicBusConstants }),
  "topicBusConstants",
  (implementation, language) => {
    describe(`topic-bus protocol constants (${language})`, () => {
      it("keeps channel and notification limits wire-compatible", () => {
        assert.deepEqual(implementation, {
          defaultChannel: "dbx_tools_topic_bus",
          maxChannelLength: 63,
          channelHashLength: 6,
          channelFallback: "bus",
          maxNotifyBytes: 7_900,
          minReconnectDelay: 0.25,
          maxReconnectDelay: 5,
        });
      });
    });
  },
  {
    identifiers: {
      python: new URL("./support/topic_bus_constants.py", import.meta.url).href,
    },
  },
);

describe("PostgresTopicBus", () => {
  it("broadcasts an envelope through pg_notify", async () => {
    const { pool, queries } = fixture();
    const bus = new PostgresTopicBus(pool, {
      metadata: { project: "automatic-project", publicIp: "203.0.113.8" },
    });
    const message = await bus.broadcast("orders", {
      type: "order.updated",
      metadata: { project: "caller-project", priority: "high", hostname: null },
      body: { id: 7 },
    });
    assert.equal(queries[0]?.text, "SELECT pg_notify($1, $2)");
    assert.equal(queries[0]?.values?.[0], bus.channelName);
    assert.match(bus.channelName, /^dbx_tools_topic_bus_[0-9a-z]{6}$/);
    const encoded = JSON.parse(String(queries[0]?.values?.[1]));
    assert.equal(encoded.type, "order.updated");
    assert.deepEqual(encoded.body, { id: 7 });
    assert.equal(encoded.metadata.project, "caller-project");
    assert.equal(encoded.metadata.publicIp, "203.0.113.8");
    assert.equal(encoded.metadata.priority, "high");
    assert.equal(encoded.metadata.hostname, null);
    assert.equal("cwd" in encoded.metadata, false);
    assert.equal("arch" in encoded.metadata, false);
    assert.equal("runtime" in encoded.metadata, false);
    assert.equal("runtimeVersion" in encoded.metadata, false);
    assert.equal("pid" in encoded.metadata, false);
    assert.equal("clientIp" in encoded.metadata, false);
    assert.equal(message.topic, "orders");
  });

  it("does not auto-attach public IP, client IP, or pid", async () => {
    const { pool, queries } = fixture();
    const bus = new PostgresTopicBus(pool);
    await bus.broadcast("orders", { type: "order.updated", body: { id: 1 } });
    const encoded = JSON.parse(String(queries[0]?.values?.[1]));
    assert.equal("publicIp" in encoded.metadata, false);
    assert.equal("clientIp" in encoded.metadata, false);
    assert.equal("pid" in encoded.metadata, false);
  });

  it("uses one dedicated LISTEN connection and filters by topic", async () => {
    const { client, pool } = fixture();
    const bus = new PostgresTopicBus(pool);
    const channel = bus.channelName;
    const received: unknown[] = [];
    const unsubscribe = await bus.listen("orders", (message) => received.push(message.body));
    assert.equal(client.queries[0]?.text, `LISTEN "${channel}"`);

    client.emit("notification", {
      channel,
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
      channel,
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
    assert.equal(client.queries.at(-1)?.text, `UNLISTEN "${channel}"`);
    assert.equal(client.released, true);
  });

  it("rejects oversized and unserializable notifications", async () => {
    const { pool } = fixture();
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
    const channel = bus.channelName;
    await bus.listen("orders", (message) => received.push(message.body));

    const connectionError = new Error("connection lost");
    first.emit("error", connectionError);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(first.released, true);
    assert.equal(first.releaseError, connectionError);
    assert.equal(second.queries[0]?.text, `LISTEN "${channel}"`);
    second.emit("notification", {
      channel,
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
