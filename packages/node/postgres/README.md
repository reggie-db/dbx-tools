# `@dbx-tools/postgres`

Reusable PostgreSQL utilities for Node.js packages in `dbx-tools`.

## Key Features

- Accepts a normal `pg.Pool` or any structurally compatible pool, including the
  pool exported by AppKit's Lakebase plugin.
- Converts arbitrary structured keys into stable signed 64-bit advisory-lock
  identifiers.
- Holds session locks on one dedicated pooled connection.
- Holds transaction locks through `COMMIT` or `ROLLBACK` for schema setup and
  migrations.
- Preserves explicit bigint lock IDs for interoperability with other clients.
- Broadcasts structured JSON messages with `pg_notify` and filters them by topic.
- Standardizes every message as `type`, `metadata`, and `body`, plus generated
  message identity, topic, and publication time.
- Auto-fills missing metadata with project, machine, process, environment,
  deployment, optional AppKit sender identity, and configured context such as
  public IP.
- Holds one dedicated pooled connection for `LISTEN`, so every app instance
  receives every broadcast without competing consumers.
- Reconnects the dedicated listener with bounded exponential backoff after a
  connection error while subscribers remain active.

## Quick Start

```ts
import { withAdvisoryLock } from "@dbx-tools/postgres";
import { Pool } from "pg";

const pool = new Pool();

await withAdvisoryLock(pool, ["invoice", invoiceId], async (client) => {
  await client.query("UPDATE invoices SET status = 'sent' WHERE id = $1", [invoiceId]);
});
```

Use the transaction-scoped helper for one-time database work:

```ts
import { withAdvisoryTransactionLock } from "@dbx-tools/postgres";

await withAdvisoryTransactionLock(pool, { schema: "my_feature", version: 1 }, async (client) => {
  await client.query("CREATE TABLE IF NOT EXISTS my_feature.events (id bigint primary key)");
});
```

Broadcast and listen by topic:

```ts
import { PostgresTopicBus } from "@dbx-tools/postgres";

const bus = new PostgresTopicBus(pool, {
  metadata: async () => ({ publicIp: await resolvePublicIp() }),
});
const unsubscribe = await bus.listen("orders", ({ type, metadata, body }) => {
  console.log(type, metadata.project, body);
});

await bus.broadcast("orders", {
  type: "order.updated",
  metadata: { traceId: "abc-123" },
  body: { orderId: "123", status: "ready" },
});
await unsubscribe();
await bus.close();
```

Caller metadata wins when a key is also available from automatic context. The
built-in context includes `project`, `hostname`, `cwd`, platform, process id,
environment, AppKit deployment details, and environment-provided public IP. If
the optional `@databricks/appkit` peer is installed and a user execution context
is active, `senderId`, `senderName`, and `senderEmail` are also added. AppKit is
loaded lazily and is not required for normal Postgres use. Pass `metadata` in
the constructor to enrich messages with async context such as a discovered
public IP or app-specific instance id.

Notifications are live and limited by PostgreSQL's `NOTIFY` payload size. The
message must round-trip through JSON without coercion: non-finite numbers,
cycles, class instances, functions, symbols, and `undefined` are rejected. Use a
table or queue when subscribers need replay or durable delivery.

## Why A Separate Package?

Advisory locks are connection-scoped. Calling `pool.query()` for the lock and
again for protected work can use different connections and therefore provides
no protection. This package owns that easy-to-miss lifecycle once and gives all
future Postgres utilities a dependency-light home.

## Module Map

| Module         | Purpose                                                            |
| -------------- | ------------------------------------------------------------------ |
| `advisoryLock` | Stable lock IDs plus session- and transaction-scoped lock helpers. |
| `topicBus`     | Structured topic broadcast/listen over PostgreSQL `NOTIFY`.        |
