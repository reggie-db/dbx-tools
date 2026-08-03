# `@dbx-tools/postgres`

Connection-correct PostgreSQL primitives for Node.js: advisory locks that hold the
connection they lock, and a structured topic bus over `LISTEN`/`NOTIFY`.

Both work against a plain `pg.Pool` or anything structurally compatible with one,
including the pool AppKit's Lakebase plugin exports — so a Databricks App gets
them without a second database client or connection pool.

## Key Features

- Converts an arbitrary structured key (string, array, object, `Date`, or an
  explicit `bigint`) into a stable signed 64-bit advisory-lock identifier.
- Derives a legal Postgres channel name from whatever identifies a channel, so no
  call site has to sanitize an app name or a tenant id into an identifier.
- Holds a session lock on one dedicated pooled connection for the whole callback,
  and hands that connection to the callback so protected work runs on it.
- Holds a transaction lock released atomically by `COMMIT` or `ROLLBACK`, which is
  what one-time schema installation needs.
- Broadcasts a `type`/`metadata`/`body` envelope to every listening process over
  `pg_notify`, filtered by topic in-process.
- Fills in project, machine, process, deployment, and optional AppKit sender
  context automatically, with caller metadata always winning.
- Rejects a payload that would not survive a JSON round trip unchanged, at the
  call site rather than on the wire.
- Reconnects a dropped listener with bounded backoff while subscribers remain.

## Advisory Locks

```ts
import { withAdvisoryLock } from "@dbx-tools/postgres";
import { Pool } from "pg";

const pool = new Pool();

await withAdvisoryLock(pool, ["invoice", invoiceId], async (client) => {
  await client.query("UPDATE invoices SET status = 'sent' WHERE id = $1", [invoiceId]);
});
```

Run the protected work on the `client` the callback receives. A `pool.query()`
inside the callback may land on a different connection, which is not the one
holding the lock.

Use the transaction-scoped helper for one-time database work:

```ts
import { withAdvisoryTransactionLock } from "@dbx-tools/postgres";

await withAdvisoryTransactionLock(pool, { schema: "my_feature", version: 1 }, async (client) => {
  await client.query("CREATE TABLE IF NOT EXISTS my_feature.events (id bigint primary key)");
});
```

`advisoryLockId(key)` exposes the same reduction on its own. A `bigint` key is
used directly (narrowed to 64 bits) rather than hashed, so a lock can interoperate
with another implementation that publishes its numeric lock id — `pgmq`'s
installer lock, for instance. Anything else is canonicalized with
`object.toStableKey` from `@dbx-tools/shared-core` and hashed, so key order in an
object does not matter while a `1` and a `"1"` stay different locks. An array is
read as several parts, so `["invoice", 7]` and `"invoice_7"` are different locks. A
non-finite number or a cyclic key throws `TypeError` rather than yielding an
identity two callers could disagree about.

## Topic Bus

```ts
import { PostgresTopicBus } from "@dbx-tools/postgres";

const bus = new PostgresTopicBus(pool, {
  metadata: async () => ({ publicIp: await resolvePublicIp() }),
  onError: (cause) => logger.error("bus", { cause }),
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

Every process listening on the channel receives every message; there are no
competing consumers. That makes the bus right for live fan-out — an SSE stream per
browser tab, a cache invalidation, a presence ping — and wrong for work
distribution. Use a table or a queue when a subscriber needs acks or replay.

### The Envelope

| Field         | Source | Notes                                                              |
| ------------- | ------ | ------------------------------------------------------------------ |
| `id`          | bus    | Unique per message across instances. Use it to dedupe or as `id:`. |
| `topic`       | bus    | The `broadcast` topic. Listeners on other topics never see it.     |
| `type`        | caller | Event name, e.g. `order.updated`. Required, non-blank.             |
| `metadata`    | merged | Automatic context under the caller's. See below.                   |
| `body`        | caller | Passed through unchanged.                                          |
| `publishedAt` | bus    | ISO-8601, from the publisher's clock — not the database's.         |

`publishedAt` and `id` are for display and dedupe. Neither orders messages from
different instances reliably.

### Metadata Precedence

Weakest to strongest: automatic machine context, then AppKit sender identity, then
the bus's `metadata` option, then the per-message `metadata`. A key present at a
stronger layer is never overwritten, so passing `project` explicitly replaces the
inferred one. An explicit `null` is also preserved and prevents an automatic value
from being used for that key.

Automatic keys, each omitted when it resolves to nothing: `project` (from
`DATABRICKS_APP_NAME`, `DATABRICKS_BUNDLE_NAME`, `PROJECT_NAME`, or
`npm_package_name`), `publicIp` (from `PUBLIC_IP`, `DATABRICKS_PUBLIC_IP`, or
`HOST_IP`), `hostname`, `platform`, `pid`, `environment`, `appName`,
`deploymentId`, and `databricksHost`. CPU architecture, runtime name, and runtime
version are left out on purpose: they are constant per deployment and every
message would pay for them against the payload limit.

`publicIp` is only read from the environment. The bus makes no network call to
discover one — pass a `metadata` function for that, which is also how to attach
context a process learns after construction. The function runs on every broadcast,
so memoize anything expensive.

With the optional `@databricks/appkit` peer installed and a user execution context
active, `senderId`, `senderName`, and `senderEmail` are added too. AppKit is
imported lazily and never required; outside a request, or without the package, the
bus just skips those keys.

### What A Message May Contain

The body and metadata must survive `JSON.parse(JSON.stringify(x))` unchanged, which
is stricter than `JSON.stringify` not throwing. A `Date` becomes a string, `NaN`
and `Infinity` become `null`, a `Map` becomes `{}`, and `undefined` vanishes — each
reaches the listener as something other than what was sent, so all of them throw
`TypeError` at the call instead. Cycles, functions, symbols, bigints, and class
instances are rejected for the same reason.

The rule lives in `@dbx-tools/shared-core` as `object.isSerializableValue` and
`object.SerializableValue`, so a route can apply the same check to an untrusted
request body and answer 400 rather than 500, and a browser-side caller can share
the type.

The encoded envelope is capped at 7900 bytes, under PostgreSQL's 8000-byte
`NOTIFY` limit, and a larger one throws `RangeError`. Automatic metadata counts
against that, so broadcast a reference and let the receiver fetch anything big.

### Connections, Lifecycle, And Failure

Publishing borrows a pooled connection per call. Listening cannot: `LISTEN` is
session state, so the bus checks out ONE dedicated client and keeps it for as long
as it has subscribers, however many topics and listeners are registered. Size the
pool with that long-lived checkout in mind.

Nothing connects until the first `listen`, or an explicit `start()` when you would
rather find out about a connection problem at boot. `close()` releases the client
and is required — register it with the host's shutdown hook. A closed bus stays
closed and throws instead of silently reconnecting.

When the notification connection drops, the bus reconnects on its own: immediately
first, then doubling from 250ms to a 5s ceiling, indefinitely, for as long as
subscribers remain. A Postgres restart or a rotated Lakebase credential recovers
without intervention. Messages published during the gap are lost. Every failed
attempt, every dropped connection, and every listener that throws is reported
through `onError`, which defaults to swallowing them — wire it to a logger in
anything long-running. A failing listener never affects the publisher or the other
listeners.

One channel carries many topics, so adding a topic costs nothing; give a genuinely
high-volume unrelated stream its own channel instead, since every listening
session decodes every message on the channel.

### Naming A Channel

`channel` takes whatever identifies the channel, not a pre-sanitized identifier —
a name, a tenant id, a `[env, feature]` pair, a config object. One value or many:
an array is read as several parts, anything else as one.

```ts
new PostgresTopicBus(pool, { channel: "billing-events" }).channelName;
// "billing_events_3x55ck"
new PostgresTopicBus(pool, { channel: ["billing", "production"] }).channelName;
// "billing_production_008jgf"
```

The parts are tokenized into the readable half and a short hash of their canonical
form (`object.toStableKey`) is appended. The hash is what makes the mapping
trustworthy: tokenizing alone is lossy, so `my-app`, `my_app`, and `myApp` would
collapse onto one channel, and a name long enough to hit Postgres's 63-character
limit would collide with anything sharing its leading tokens. With the suffix the
readable part stays readable and distinct inputs stay distinct — including
`["billing", "prod"]` versus `"billing_prod"`, which differ in structure.

Derivation is deterministic across processes and runs, so every participant that
passes equivalent parts lands on the same channel without coordinating. Object key
order does not matter; a different spelling does. Read `bus.channelName` to see
what a set of parts resolved to, or to confirm two processes agree. Defaults to a
shared `dbx_tools_topic_bus` channel.

## Why A Separate Package?

Advisory locks are connection-scoped, and that is easy to get wrong invisibly:
taking the lock with `pool.query()` and doing the protected work with another
`pool.query()` can use two different connections, so the lock protects nothing and
the code looks correct. The same applies to `LISTEN`, which is session state a
pooled query cannot hold. This package owns both lifecycles once, with no
dependency beyond `pg`, so a consumer that only needs a lock does not pull in a
message bus, an AppKit runtime, or a queue extension.

AppKit exposes Lakebase but has no lock helper and no message bus, so there is no
native surface to prefer here.

## Module Map

| Module         | Purpose                                                            |
| -------------- | ------------------------------------------------------------------ |
| `advisoryLock` | Stable lock IDs plus session- and transaction-scoped lock helpers. |
| `topicBus`     | Structured topic broadcast/listen over PostgreSQL `NOTIFY`.        |

Both modules are also flattened onto the package root, so
`import { withAdvisoryLock, PostgresTopicBus } from "@dbx-tools/postgres"` works
without the namespace.
