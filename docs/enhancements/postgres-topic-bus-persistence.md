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

Use exactly two package-owned tables, one per access tier:

```text
dbx_message_bus.public_messages   -- open to every bus participant
dbx_message_bus.scoped_messages   -- restricted to holders of a scope grant
```

Do not create a table named after the bus, channel, or topic, and do not use `_` as an
unnamed-table convention. Both tables store the resolved bus `channelName` and the
message `topic` as columns, so adding a channel or topic never adds a table.

Two tables rather than one, because the access tier is the only thing that genuinely
needs a different PostgreSQL grant. Splitting on tier keeps the boundary enforced by
`GRANT` on a table instead of by a `WHERE` clause every caller must remember:

- a role that may read open traffic gets the public table and never the scoped one;
- no predicate, view, or RLS policy is load-bearing for isolation in version 1;
- a leaked or over-broad public grant cannot expose scoped payloads;
- both tables share one identical column layout, one migrator, and one replay
  implementation, so the split costs no duplicated logic;
- `channel` and `topic` remain routing keys, not security principals.

Two tables, and only two. Do not add a third tier, a per-tenant table, or a table per
channel. Deployments needing finer isolation should install the schema separately or
wait for a deliberate RLS design.

Within a tier the boundary is still tier-wide: a role holding the scoped grant can read
every scoped channel and topic. The tier answers "may this role see restricted traffic
at all", not "which restricted topics may it see".

## Proposed API

Keep persistence disabled unless explicitly requested:

```ts
const bus = new PostgresTopicBus(pool, {
  channel: ["billing", "production"],
  persist: true,
});
```

`persist: true` expands to defaults rather than a second behavior mode, and defaults to
the public tier:

```ts
/** Which package-owned table a message is stored in. */
type TopicPersistenceScope = "public" | "scoped";

type TopicBusPersistenceOptions = {
  /** Default: "dbx_message_bus". */
  schema?: string;
  /** Default: "public". The tier, and therefore the table, messages land in. */
  scope?: TopicPersistenceScope;
  /**
   * Default: { public: "public_messages", scoped: "scoped_messages" }.
   * Primarily for tests or managed installations.
   */
  tables?: Partial<Record<TopicPersistenceScope, string>>;
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

`scope` is deliberately a bus-level default rather than a per-message flag alone, so an
app that only handles restricted traffic configures the tier once:

```ts
const bus = new PostgresTopicBus(pool, {
  channel: ["billing", "production"],
  persist: { scope: "scoped" },
});
```

A publisher may still override the tier per message when one channel carries both, and
`history` may be read from either tier explicitly:

```ts
await bus.broadcast("orders", {
  type: "order.repriced",
  body: { id: 7, margin: 0.18 },
  scope: "scoped",
});

const page = await bus.history("orders", { scope: "scoped" });
```

Public must be the default. A caller who forgets the option should land in the tier that
leaks nothing restricted, and marking something restricted should be the explicit act.

The Python options should expose the same behavior and both Python naming styles:
`persist`, `scope`, `ttl`, `cleanup_batch_size` / `cleanupBatchSize`, and `provision`.

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
  scope: TopicPersistenceScope;
  message: TopicMessage<TBody>;
};

type TopicHistoryPage<TBody extends SerializableValue = SerializableValue> = {
  messages: StoredTopicMessage<TBody>[];
  nextCursor?: string;
};
```

The cursor should be opaque to callers. Internally it can encode the tier plus the
table's monotonic `sequence`, which is reliable for replay even though the envelope's
`publishedAt` comes from a process clock and is not safe for cross-instance ordering.
Encoding the tier lets the reader reject a cursor issued by the other table instead of
silently paging from the wrong sequence, since the two tables have independent identity
columns.

One `history` call reads ONE tier. Do not merge both tables into a single page: their
sequences are independent, so a merged result has no single monotonic cursor, and a
reader lacking the scoped grant would turn a routine page into a permission error.

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

Both tables share one column layout. Generate them from one definition so the tiers
cannot drift:

```sql
CREATE SCHEMA IF NOT EXISTS dbx_message_bus;

CREATE TABLE IF NOT EXISTS dbx_message_bus.public_messages (
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

CREATE TABLE IF NOT EXISTS dbx_message_bus.scoped_messages (
  LIKE dbx_message_bus.public_messages INCLUDING ALL
);

CREATE INDEX IF NOT EXISTS public_messages_replay_idx
  ON dbx_message_bus.public_messages (channel, topic, sequence);

CREATE INDEX IF NOT EXISTS public_messages_expiry_idx
  ON dbx_message_bus.public_messages (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS scoped_messages_replay_idx
  ON dbx_message_bus.scoped_messages (channel, topic, sequence);

CREATE INDEX IF NOT EXISTS scoped_messages_expiry_idx
  ON dbx_message_bus.scoped_messages (expires_at)
  WHERE expires_at IS NOT NULL;
```

`LIKE ... INCLUDING ALL` copies the identity column, defaults, `CHECK` constraint,
primary key, and the `UNIQUE (channel, message_id)` index, so the second table needs no
repeated column list at creation time. Verified on PostgreSQL 16: `scoped_messages`
comes out with its own `scoped_messages_sequence_seq`, `scoped_messages_pkey`, and
`scoped_messages_channel_message_id_key`.

Even so, the migrator should emit each tier's DDL from the same internal template rather
than defining one table in terms of the other. `LIKE` copies structure once at creation
and does not keep the tables in sync afterward, so a later column addition must be
applied to both explicitly.

Deliberately NOT a `scope` column on one shared table. A column would make isolation
depend on every query remembering a predicate, and a single missed `WHERE` would return
restricted rows to a public reader. A separate table makes the same mistake a
permission error instead of a data leak.

Deliberately NOT a partitioned table with one partition per tier either. Partitions of
one parent are convenient to query together, which is exactly the property that would
let a public reader select scoped rows through the parent.

Store the complete wire envelope in `envelope` rather than splitting `type`,
`metadata`, and `body` into separate authoritative columns. The routing, ordering,
and lifecycle fields are duplicated as typed columns because they are queried and
indexed. The JSON envelope remains the source returned to callers, which avoids a
storage migration whenever an optional envelope field is added.

Use `TEXT` for `message_id`, not PostgreSQL `UUID`. Node currently creates ids through
`hash.id()` and Python through `uuid.uuid4()`; the public contract promises a string,
not a UUID forever.

The resolved table name must come from the tier enum, never from caller input. Map
`"public"` and `"scoped"` onto the configured identifiers and reject anything else, so
no user-supplied string reaches DDL or a query as an identifier.

Expired rows are invisible to history even before physical cleanup:

```sql
WHERE channel = $1
  AND topic = $2
  AND sequence > $3
  AND (expires_at IS NULL OR expires_at > clock_timestamp())
ORDER BY sequence
LIMIT $4
```

The same predicate applies to both tables; only the resolved table name differs.

## Persisted publish transaction

When persistence is enabled, `broadcast` should use one borrowed connection and one
transaction:

1. lazily ensure the persistence schema is provisioned;
2. delete a bounded batch of expired rows from the target tier's table;
3. insert the envelope and computed expiry into that same table;
4. call `pg_notify` with the same encoded envelope;
5. commit, which is when PostgreSQL delivers the notification.

This ordering gives the useful invariant that a live notification is not delivered for
a row that failed to persist. If persistence or notification fails, the transaction
rolls back and `broadcast` rejects.

Do not publish first and persist afterward. A process crash between those operations
would produce a live-only message even though persistence was requested.

A publish touches exactly ONE tier's table. Cleanup runs against the tier being
published to, so a process holding only the public grant never needs privileges on the
scoped table to publish or to clean up. That is what keeps the two grants genuinely
independent.

Note that `LISTEN` / `NOTIFY` is not tier-aware: the channel is shared, so any session
listening on it still receives a scoped message live. Persistence tiers govern STORED
access, not live fan-out. Give restricted traffic its own `channel` when live delivery
must also be separated, and say so plainly in the README.

The cleanup should be bounded so one publish cannot inherit an unbounded deletion:

```sql
WITH expired AS (
  SELECT ctid
  FROM dbx_message_bus.public_messages
  WHERE expires_at IS NOT NULL
    AND expires_at <= clock_timestamp()
  ORDER BY expires_at
  LIMIT $1
)
DELETE FROM dbx_message_bus.public_messages AS messages
USING expired
WHERE messages.ctid = expired.ctid;
```

Run this on every persisted publish, as requested. The partial expiry index keeps the
lookup cheap, the batch limit caps write amplification, and ordinary autovacuum handles
the resulting dead tuples. Also expose `cleanupExpired({ scope, limit })` for maintenance
jobs that want to drain more aggressively; it should default to the bus's configured tier
and accept an explicit one, so a maintenance process with both grants can drain each
table without constructing two buses.

The non-persistent path should retain the current single `SELECT pg_notify(...)` query
and should not run provisioning or cleanup code.

## Provisioning and migrations

Provision once per process on the first persisted operation and memoize the in-flight
promise so concurrent initial broadcasts do not each run DDL.

Provision BOTH tables together, even when a process only publishes to one tier. A
half-installed schema is the failure mode where a scoped publisher works locally and
then finds no scoped table in production. Provisioning is an administrative act, so it
should produce the complete installation; a runtime role that lacks the scoped grant
still never touches that table at publish time.

Protect schema upgrades with the package's existing transaction-level advisory lock,
using a stable key such as:

```ts
["dbx_message_bus", "schema"];
```

One lock key covers both tables, since they migrate as a single versioned unit.

Create a small `dbx_message_bus.schema_version` table or equivalent singleton metadata
row from the start. `CREATE TABLE IF NOT EXISTS` is enough for version 1, but it cannot
safely express later column changes. A versioned migrator avoids making users manually
repair installations as the package evolves.

`provision: false` supports installations where an administrator owns schema changes
and the runtime role has DML only. In that mode, a missing or old schema should fail
with an actionable error naming the required provision helper or SQL migration, and the
error should name the TIER whose table is missing so the fix is unambiguous.

## Access model

Do not automatically grant the schema to `PUBLIC`, and do not copy the broad
database-wide grant block from the motivating example into package startup. `PUBLIC`
would include every database login, and `CREATE ON SCHEMA` would let runtime roles place
arbitrary objects beside package-owned tables.

The two tables exist so the tier is a grant. Model each tier as a PostgreSQL group role
and grant membership to app identities, rather than granting tables to each identity
directly:

```sql
CREATE ROLE dbx_message_bus_public NOLOGIN;
CREATE ROLE dbx_message_bus_scoped NOLOGIN;

-- Schema USAGE is required by both tiers and grants nothing on its own.
GRANT USAGE ON SCHEMA dbx_message_bus TO dbx_message_bus_public, dbx_message_bus_scoped;

GRANT SELECT, INSERT, DELETE ON TABLE dbx_message_bus.public_messages
  TO dbx_message_bus_public;

GRANT SELECT, INSERT, DELETE ON TABLE dbx_message_bus.scoped_messages
  TO dbx_message_bus_scoped;
```

No sequence grant is required, and none should be issued. `GENERATED ALWAYS AS IDENTITY`
owns its sequence implicitly, so `INSERT` privilege on the table is sufficient — verified
on PostgreSQL 16 by inserting as a role holding only `SELECT, INSERT, DELETE`. This is
the practical difference from a `serial` column, which does require
`GRANT USAGE ON SEQUENCE`; do not copy that habit here.

The scoped role is NOT a superset of the public role by default. Keep the tiers
independent and grant both memberships when an identity needs both, so "may read
restricted traffic" never silently implies anything about open traffic:

```sql
GRANT dbx_message_bus_public TO "452f8cc3-d3c5-450c-8671-967263a92a2d";
GRANT dbx_message_bus_scoped TO "452f8cc3-d3c5-450c-8671-967263a92a2d";
```

Since both tiers share the schema, `USAGE` on the schema must remain non-privileged.
Schema `USAGE` alone cannot and should not imply table DML; the table grant is the
boundary. That is the honest version of "schema access gives topic access": within a
granted tier, every channel and topic is reachable and no topic-specific grants exist.

If the migration metadata table is runtime-readable, grant only `SELECT` on it to both
roles.
`UPDATE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, schema `CREATE`, and type grants are not
needed for normal bus operation.

Provide a quoted, tested helper such as
`messageBusGrantStatements(role, { scope, options })`, plus an optional
`provisionMessageBusSchema` wrapper, following the existing AppKit cache provisioning
pattern. The helper should take the tier explicitly and emit only that tier's statements,
accept one or more explicit roles, and never discover and grant every database role
automatically. Emitting both tiers from one call should require asking for both.

Because a tier's grant covers its whole table, granting a runtime role once is enough for
every current and future topic in that tier.

Do not add row-level security in version 1. The two tables are the isolation mechanism,
and RLS on top would duplicate it. RLS would require a trustworthy mapping from
the database session to allowed channel values, complicate pooled connections, and make
cleanup policies easy to get wrong. If tier-wide access is too broad for a deployment,
use a separate database/schema installation or add an explicit RLS design later rather
than pretending `topic` is already an authorization boundary.

## Node and Python parity

Persistence changes the shared bus contract, so Node and Python should ship together.

Shared polyglot fixtures should pin at least:

- default TTL and `false` handling;
- computed `expires_at` for fixed publish times;
- stored envelope shape;
- channel/topic/message-id storage keys;
- tier-to-table resolution for both `"public"` and `"scoped"`;
- the default tier being `"public"`;
- per-message tier override precedence over the bus default;
- cursor ordering and pagination boundaries;
- cursor tier tagging and rejection of a cursor from the other tier;
- exclusion of expired rows;
- per-message TTL override precedence.

Runtime-specific tests should cover:

- lazy, concurrent-safe provisioning;
- provisioning creating both tier tables and their indexes;
- advisory-lock guarded migration;
- cleanup, insert, and `pg_notify` in one transaction;
- a publish touching only its own tier's table;
- rollback on insert or notification failure;
- unchanged one-query behavior when persistence is disabled;
- bounded cleanup SQL and expiry index usage;
- history pagination and malformed stored-envelope handling;
- permission helper quoting for email- and UUID-shaped Databricks roles, per tier;
- rejection of an unknown tier value before it reaches SQL;
- race-free listen-plus-replay deduplication.

The Python implementation should continue accepting structural engine protocols. The
Node implementation may need a slightly richer internal pool/client protocol for
transactional publish, but should not require callers to use the concrete `pg.Pool`
type.

## Delivery phases

### Phase 1: durable storage primitive

1. Add shared persistence option, tier, and TTL types.
2. Add versioned two-table provisioning and per-tier grant-statement helpers.
3. Persist, clean up, and notify in one transaction against the resolved tier.
4. Add tier-aware `history` and `cleanupExpired`.
5. Port the same behavior to Python and add polyglot fixtures.
6. Update both package READMEs to distinguish live-only from persisted modes, and the
   public tier from the scoped tier, including the fact that live `NOTIFY` fan-out is not
   tier-aware.

### Phase 2: replay subscription

1. Add opaque, tier-tagged cursors to history results.
2. Establish `LISTEN` before querying history.
3. Buffer live messages during replay.
4. Deduplicate persisted and buffered messages by id.
5. Document at-least-once replay behavior and listener idempotency.

### Phase 3: operations

1. Add per-tier table-size, expired-row, and oldest-message inspection queries.
2. Document autovacuum and maintenance-job guidance for high-volume buses.
3. Consider partitioning only after measured table volume justifies it.
4. Revisit RLS only with a concrete multi-tenant authorization requirement.

## Explicit non-goals

- No competing-consumer queue, acknowledgements, leases, or retries.
- No exactly-once delivery promise.
- No table per topic, channel, or bus instance.
- No third access tier, and no caller-defined tier names.
- No `scope` column standing in for the two tables.
- No tier-aware live `LISTEN` / `NOTIFY` delivery.
- No implicit scoped access for a role holding only the public grant.
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
5. Confirm the tier names. `"public"` / `"scoped"` match the table names, but
   `"open"` / `"restricted"` reads less like PostgreSQL's `PUBLIC` role, which these
   grants deliberately avoid.
6. Decide whether the scoped tier should also carry a default TTL shorter than 24 hours,
   since restricted payloads are the ones a deployment is most likely to want retained
   briefly.

## Verified against PostgreSQL 16

The SQL in this document was executed against a throwaway PostgreSQL 16 cluster rather
than written from memory. What the run established:

- the two-table DDL and both partial expiry indexes apply cleanly, and
  `LIKE ... INCLUDING ALL` reproduces the identity column, constraints, and indexes under
  tier-prefixed names;
- a role holding only `SELECT, INSERT, DELETE` on a tier table can insert into the
  `GENERATED ALWAYS AS IDENTITY` column with NO sequence grant;
- a public-tier-only role is denied both `SELECT` and `INSERT` on `scoped_messages`,
  which is the isolation claim the two-table split exists to make;
- a role holding both group memberships reads both tables;
- the history predicate hides expired rows before any deletion runs;
- the bounded cleanup deletes exactly its `LIMIT` and leaves the remaining expired rows
  for the next call;
- the cleanup query plans as an index scan on the partial expiry index.

Email-shaped and UUID-shaped Databricks role names were used for the grant tests, since
those are the identities that require quoting in generated SQL.
