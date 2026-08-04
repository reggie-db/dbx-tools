# PostgreSQL topic bus persistence

Date: 2026-08-04

Status: proposed.

## Purpose

Add optional, TTL-bounded persistence and replay to the Node and Python
`PostgresTopicBus` implementations without turning every bus or topic into a new
PostgreSQL table, migration, or grant problem.

The current bus is deliberately live-only: it publishes one JSON envelope through
`LISTEN` / `NOTIFY`, keeps one notification connection per bus channel, and filters
topics in-process. That remains the default. Persistence should be an opt-in layer
around the same envelope and should not change the existing fast path when disabled.

## Recommendation

Use one package-owned table:

```text
dbx_message_bus.messages
```

Do not create a table named after the bus, channel, or topic, and do not use `_` as
an unnamed-table convention. Store the resolved bus `channelName` and the message
`topic` as columns instead.

This matches the bus's existing **one channel, many topics** design and has several
advantages:

- one schema and table to provision, migrate, grant, monitor, vacuum, and index;
- no identifier sanitization or dynamic SQL for user-supplied bus names;
- no per-topic or per-bus DDL during application startup;
- no new table grants when a caller starts using another topic;
- one replay implementation shared by all buses;
- a straightforward future path to row-level security if bus isolation is ever
  required.

The access boundary is intentionally the whole persisted message bus. A role with
table access can access every persisted channel and topic. `channel` and `topic` are
routing keys, not security principals.

## Proposed API

Keep persistence disabled unless explicitly requested:

```ts
const bus = new PostgresTopicBus(pool, {
  channel: ["billing", "production"],
  persist: true,
});
```

`persist: true` expands to defaults rather than a second behavior mode:

```ts
type TopicBusPersistenceOptions = {
  /** Default: "dbx_message_bus". */
  schema?: string;
  /** Default: "messages". Primarily for tests or managed installations. */
  table?: string;
  /** Default: 24 hours. Set false for messages that do not expire by default. */
  ttl?: DurationInput | false;
  /** Default: 1,000 expired rows per persisted publish. */
  cleanupBatchSize?: number;
  /** Default: true. Create/upgrade package-owned objects on first persisted use. */
  provision?: boolean;
};

type PostgresTopicBusOptions = {
  // Existing options.
  channel?: unknown;
  metadata?: TopicMetadata | TopicMetadataProvider;
  onError?: (cause: unknown) => void;

  // New option.
  persist?: boolean | TopicBusPersistenceOptions;
};
```

The Python options should expose the same behavior and both Python naming styles:
`persist`, `ttl`, `cleanup_batch_size` / `cleanupBatchSize`, and `provision`.

Allow a per-message TTL override without putting expiry into caller metadata:

```ts
await bus.broadcast("orders", {
  type: "order.updated",
  body: { id: 7 },
  ttl: "15 minutes",
});

await bus.broadcast("orders", {
  type: "order.audit-recorded",
  body: { id: 7 },
  ttl: false,
});
```

Resolution order:

1. `input.ttl` when supplied;
2. the bus persistence `ttl`;
3. 24 hours.

`false` means `expires_at IS NULL`. It must be explicit because indefinite retention
should not be the default.

Add a bounded history API before adding automatic replay to `listen`:

```ts
const page = await bus.history("orders", {
  after: cursor,
  limit: 100,
});

for (const stored of page.messages) {
  consume(stored.message);
}
```

Proposed return shape:

```ts
type StoredTopicMessage<TBody extends SerializableValue = SerializableValue> = {
  cursor: string;
  expiresAt: string | null;
  message: TopicMessage<TBody>;
};

type TopicHistoryPage<TBody extends SerializableValue = SerializableValue> = {
  messages: StoredTopicMessage<TBody>[];
  nextCursor?: string;
};
```

The cursor should be opaque to callers. Internally it can encode the table's monotonic
`sequence`, which is reliable for replay even though the envelope's `publishedAt` comes
from a process clock and is not safe for cross-instance ordering.

After the history primitive is stable, add a convenience replay subscription:

```ts
await bus.listen("orders", listener, {
  replay: { after: cursor },
});
```

That method must establish `LISTEN` first, read persisted rows second, then drain live
notifications received during the query while deduplicating by message id. Querying
first and listening second creates a gap in which a message can be missed.

## Storage schema

Recommended initial shape:

```sql
CREATE SCHEMA IF NOT EXISTS dbx_message_bus;

CREATE TABLE IF NOT EXISTS dbx_message_bus.messages (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel TEXT NOT NULL,
  topic TEXT NOT NULL,
  message_id TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  envelope JSONB NOT NULL,
  UNIQUE (channel, message_id),
  CHECK (jsonb_typeof(envelope) = 'object')
);

CREATE INDEX IF NOT EXISTS messages_replay_idx
  ON dbx_message_bus.messages (channel, topic, sequence);

CREATE INDEX IF NOT EXISTS messages_expiry_idx
  ON dbx_message_bus.messages (expires_at)
  WHERE expires_at IS NOT NULL;
```

Store the complete wire envelope in `envelope` rather than splitting `type`,
`metadata`, and `body` into separate authoritative columns. The routing, ordering,
and lifecycle fields are duplicated as typed columns because they are queried and
indexed. The JSON envelope remains the source returned to callers, which avoids a
storage migration whenever an optional envelope field is added.

Use `TEXT` for `message_id`, not PostgreSQL `UUID`. Node currently creates ids through
`hash.id()` and Python through `uuid.uuid4()`; the public contract promises a string,
not a UUID forever.

Expired rows are invisible to history even before physical cleanup:

```sql
WHERE channel = $1
  AND topic = $2
  AND sequence > $3
  AND (expires_at IS NULL OR expires_at > clock_timestamp())
ORDER BY sequence
LIMIT $4
```

## Persisted publish transaction

When persistence is enabled, `broadcast` should use one borrowed connection and one
transaction:

1. lazily ensure the persistence schema is provisioned;
2. delete a bounded batch of expired rows;
3. insert the envelope and computed expiry;
4. call `pg_notify` with the same encoded envelope;
5. commit, which is when PostgreSQL delivers the notification.

This ordering gives the useful invariant that a live notification is not delivered for
a row that failed to persist. If persistence or notification fails, the transaction
rolls back and `broadcast` rejects.

Do not publish first and persist afterward. A process crash between those operations
would produce a live-only message even though persistence was requested.

The cleanup should be bounded so one publish cannot inherit an unbounded deletion:

```sql
WITH expired AS (
  SELECT ctid
  FROM dbx_message_bus.messages
  WHERE expires_at IS NOT NULL
    AND expires_at <= clock_timestamp()
  ORDER BY expires_at
  LIMIT $1
)
DELETE FROM dbx_message_bus.messages AS messages
USING expired
WHERE messages.ctid = expired.ctid;
```

Run this on every persisted publish, as requested. The partial expiry index keeps the
lookup cheap, the batch limit caps write amplification, and ordinary autovacuum handles
the resulting dead tuples. Also expose `cleanupExpired({ limit })` for maintenance jobs
that want to drain more aggressively.

The non-persistent path should retain the current single `SELECT pg_notify(...)` query
and should not run provisioning or cleanup code.

## Provisioning and migrations

Provision once per process on the first persisted operation and memoize the in-flight
promise so concurrent initial broadcasts do not each run DDL.

Protect schema upgrades with the package's existing transaction-level advisory lock,
using a stable key such as:

```ts
["dbx_message_bus", "schema"];
```

Create a small `dbx_message_bus.schema_version` table or equivalent singleton metadata
row from the start. `CREATE TABLE IF NOT EXISTS` is enough for version 1, but it cannot
safely express later column changes. A versioned migrator avoids making users manually
repair installations as the package evolves.

`provision: false` supports installations where an administrator owns schema changes
and the runtime role has DML only. In that mode, a missing or old schema should fail
with an actionable error naming the required provision helper or SQL migration.

## Access model

Do not automatically grant the schema to `PUBLIC`, and do not copy the broad
database-wide grant block from the motivating example into package startup. `PUBLIC`
would include every database login, and `CREATE ON SCHEMA` would let runtime roles place
arbitrary objects beside package-owned tables.

Instead, make access deliberately bus-wide but role-scoped:

```sql
GRANT USAGE ON SCHEMA dbx_message_bus TO "app-role";
GRANT SELECT, INSERT, DELETE ON TABLE dbx_message_bus.messages TO "app-role";
GRANT USAGE, SELECT ON SEQUENCE dbx_message_bus.messages_sequence_seq TO "app-role";
```

If the migration metadata table is runtime-readable, grant only `SELECT` on it.
`UPDATE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, schema `CREATE`, and type grants are not
needed for normal bus operation.

Provide a quoted, tested helper such as `messageBusGrantStatements(role, options)` and
an optional `provisionMessageBusSchema` wrapper, following the existing AppKit cache
provisioning pattern. The helper should accept one or more explicit roles; it should not
discover and grant every database role automatically.

Because all channels and topics share one table, granting a runtime role once is enough
for every current and future topic. Organizations with several app identities should
prefer a shared PostgreSQL group role and grant membership to each app identity:

```sql
CREATE ROLE dbx_message_bus_user NOLOGIN;
GRANT USAGE ON SCHEMA dbx_message_bus TO dbx_message_bus_user;
GRANT SELECT, INSERT, DELETE ON TABLE dbx_message_bus.messages
  TO dbx_message_bus_user;
GRANT USAGE, SELECT ON SEQUENCE dbx_message_bus.messages_sequence_seq
  TO dbx_message_bus_user;

GRANT dbx_message_bus_user TO "452f8cc3-d3c5-450c-8671-967263a92a2d";
```

This is the practical meaning of "schema access gives topic access": membership in the
bus role grants access to the one bus table, and no topic-specific grants exist.
PostgreSQL schema `USAGE` alone cannot and should not imply table DML.

Do not add row-level security in version 1. RLS would require a trustworthy mapping from
the database session to allowed channel values, complicate pooled connections, and make
cleanup policies easy to get wrong. If table-wide access is too broad for a deployment,
use a separate database/schema installation or add an explicit RLS design later rather
than pretending `topic` is already an authorization boundary.

## Node and Python parity

Persistence changes the shared bus contract, so Node and Python should ship together.

Shared polyglot fixtures should pin at least:

- default TTL and `false` handling;
- computed `expires_at` for fixed publish times;
- stored envelope shape;
- channel/topic/message-id storage keys;
- cursor ordering and pagination boundaries;
- exclusion of expired rows;
- per-message TTL override precedence.

Runtime-specific tests should cover:

- lazy, concurrent-safe provisioning;
- advisory-lock guarded migration;
- cleanup, insert, and `pg_notify` in one transaction;
- rollback on insert or notification failure;
- unchanged one-query behavior when persistence is disabled;
- bounded cleanup SQL and expiry index usage;
- history pagination and malformed stored-envelope handling;
- permission helper quoting for email- and UUID-shaped Databricks roles;
- race-free listen-plus-replay deduplication.

The Python implementation should continue accepting structural engine protocols. The
Node implementation may need a slightly richer internal pool/client protocol for
transactional publish, but should not require callers to use the concrete `pg.Pool`
type.

## Delivery phases

### Phase 1: durable storage primitive

1. Add shared persistence option and TTL types.
2. Add versioned schema provisioning and grant-statement helpers.
3. Persist, clean up, and notify in one transaction.
4. Add `history` and `cleanupExpired`.
5. Port the same behavior to Python and add polyglot fixtures.
6. Update both package READMEs to distinguish live-only and persisted modes.

### Phase 2: replay subscription

1. Add opaque cursors to history results.
2. Establish `LISTEN` before querying history.
3. Buffer live messages during replay.
4. Deduplicate persisted and buffered messages by id.
5. Document at-least-once replay behavior and listener idempotency.

### Phase 3: operations

1. Add table-size, expired-row, and oldest-message inspection queries.
2. Document autovacuum and maintenance-job guidance for high-volume buses.
3. Consider partitioning only after measured table volume justifies it.
4. Revisit RLS only with a concrete multi-tenant authorization requirement.

## Explicit non-goals

- No competing-consumer queue, acknowledgements, leases, or retries.
- No exactly-once delivery promise.
- No table per topic, channel, or bus instance.
- No unbounded retention by default.
- No automatic grant to `PUBLIC` or every role in the database.
- No requirement that message ids remain UUIDs.
- No persistence dependency or startup DDL when `persist` is disabled.

## Open decisions before implementation

1. Confirm 24 hours as the default TTL. It is long enough for reconnect/replay without
   turning the bus into an archive.
2. Confirm whether `history` should be allowed with `persist: false` as a clear runtime
   error or only appear on a separately typed persistent bus facade.
3. Decide whether a malformed stored envelope should fail the page or be reported to
   `onError` and skipped. The safer operational default is report-and-skip.
4. Decide whether `provision: true` should run on first `broadcast` only or also on
   `start`; provisioning on first persisted operation keeps a listen-only process able
   to call `history` without a prior publish.
