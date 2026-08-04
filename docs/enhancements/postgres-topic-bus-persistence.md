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
dbx_message_bus.open_messages   -- open to every bus participant
dbx_message_bus.restricted_messages   -- restricted to holders of the restricted grant
```

Do not create a table named after the bus, channel, or topic, and do not use `_` as an
unnamed-table convention. Both tables store the resolved bus `channelName` and the
message `topic` as columns, so adding a channel or topic never adds a table.

Two tables rather than one, because the access tier is the only thing that genuinely
needs a different PostgreSQL grant. Splitting on tier keeps the boundary enforced by
`GRANT` on a table instead of by a `WHERE` clause every caller must remember:

- a role that may read open traffic gets the open table and never the restricted one;
- no predicate, view, or RLS policy is load-bearing for isolation in version 1;
- a leaked or over-broad open grant cannot expose restricted payloads;
- both tables share one identical column layout, one migrator, and one replay
  implementation, so the split costs no duplicated logic;
- `channel` and `topic` remain routing keys, not security principals.

Two tables, and only two. Do not add a third tier, a per-tenant table, or a table per
channel. Deployments needing finer isolation should install the schema separately or
wait for a deliberate RLS design.

Within a tier the boundary is still tier-wide: a role holding the restricted grant can read
every restricted channel and topic. The tier answers "may this role see restricted traffic
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
the open tier:

```ts
/** Which package-owned table a message is stored in. */
type TopicPersistenceScope = "open" | "restricted";

type TopicBusPersistenceOptions = {
  /** Default: "dbx_message_bus". */
  schema?: string;
  /** Default: "open". The tier, and therefore the table, messages land in. */
  scope?: TopicPersistenceScope;
  /**
   * Default: { open: "open_messages", restricted: "restricted_messages" }.
   * Primarily for tests or managed installations.
   */
  tables?: Partial<Record<TopicPersistenceScope, string>>;
  /** Default: 24 hours. Set false for messages that do not expire by default. */
  ttl?: DurationInput | false;
  /**
   * Default: "envelope". "pointer" sends only routing plus identity and lets the
   * listener read the row, lifting the 8000-byte NOTIFY limit.
   */
  payload?: "envelope" | "pointer";
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
  persist: { scope: "restricted" },
});
```

A publisher may still override the tier per message when one channel carries both, and
`history` may be read from either tier explicitly:

```ts
await bus.broadcast("orders", {
  type: "order.repriced",
  body: { id: 7, margin: 0.18 },
  scope: "restricted",
});

const page = await bus.history("orders", { scope: "restricted" });
```

Open must be the default. A caller who forgets the option should land in the tier that
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
reader lacking the restricted grant would turn a routine page into a permission error.

After the history primitive is stable, add a convenience replay subscription:

```ts
await bus.listen("orders", listener, {
  replay: { after: cursor },
});
```

That method must establish `LISTEN` first, read persisted rows second, then drain live
notifications received during the query while deduplicating by message id. Querying
first and listening second creates a gap in which a message can be missed.

## Notification payload: pointer or envelope

Two delivery styles should be supported, because they fail differently.

`payload: "envelope"` (default, current behavior) sends the whole message in the
`NOTIFY` payload. One round trip, no read amplification, but bounded by PostgreSQL's
8000-byte payload limit.

`payload: "pointer"` sends only routing plus identity, and the listener reads the row:

```json
{ "v": 1, "scope": "open", "topic": "orders", "sequence": 4821, "id": "m-7f3a" }
```

A pointer is the right default for large or sensitive payloads: it lifts the size limit
entirely, and it means a listener that lacks the tier's table grant learns only that
something happened, never its contents. The cost is a read per notification, so batch it
(below) rather than issuing one query per message.

This is safe because `NOTIFY` is delivered at COMMIT, not at statement time. Verified:
an uncommitted `pg_notify` produced no notification in a listening session until its
transaction committed, and since the row and the notification commit together, a pointer
is never delivered before the row it points at is readable.

### Read from the id, not from a time window

Prefer `sequence >= :cursor` over "everything in the last 5ms". A time window looks
simpler and is the one option here that silently loses data:

- `clock_timestamp()` is taken when the INSERT executes, not when it commits, so a
  transaction open longer than the window stamps a time already outside it;
- window arithmetic mixes the publisher's clock with the reader's, and on Databricks
  those are different machines;
- a GC pause, a retry, or a slow read longer than 5ms drops whatever landed meanwhile;
- overlapping windows re-deliver rows, so the listener needs id-based dedupe regardless —
  at which point the id is doing the real work and the window is redundant.

So: use the notification's `sequence` as a lower bound, keep the last delivered
`sequence` as the cursor, and let the read be `>=` with a dedupe on `message_id`. Use
`>=` rather than `>` when recovering from an unknown position, since re-delivering one
row is harmless under id dedupe while skipping one is not.

### The gap a bare `> last_sequence` cursor leaves

An identity column allocates its value when the INSERT runs, but the row becomes visible
when the transaction COMMITS, and those orders differ. Reproduced on PostgreSQL 16:

| step                        | state                                              |
| --------------------------- | -------------------------------------------------- |
| A inserts (`sequence` 1)    | holds its transaction open                         |
| B inserts (`sequence` 2)    | commits immediately                                |
| reader polls                | sees ONLY `sequence` 2, advances its cursor to 2   |
| A commits                   | `sequence` 1 becomes visible, in the reader's past |
| reader polls `sequence > 2` | returns 0 rows — row 1 is skipped permanently      |

A notification-driven read does not remove this: the pointer for row 1 arrives at A's
commit, so a listener that only trusts its own cursor still has to reconcile an id BELOW
its high-water mark. Two mitigations, in order of cost:

1. **Trust the notification's id.** Read exactly the `sequence` the notification named,
   independent of the cursor, and dedupe by `message_id`. This handles the live path
   correctly no matter what order rows commit in, because each row's own commit delivers
   its own pointer.
2. **Advance the cursor only to a settled watermark.** For catch-up reads (reconnect and
   replay, where notifications were missed), do not advance past transactions that could
   still be in flight. Stamp each row with the inserting transaction id and treat only
   rows below the current snapshot's `xmin` as settled:

   ```sql
   ALTER TABLE dbx_message_bus.open_messages
     ADD COLUMN xact_id xid8 NOT NULL DEFAULT pg_current_xact_id();

   -- Rows safe to advance the cursor past: no in-flight transaction can precede them.
   SELECT sequence, message_id, envelope
   FROM dbx_message_bus.open_messages
   WHERE scope_conditions
     AND sequence >= :cursor
     AND xact_id < pg_snapshot_xmin(pg_current_snapshot())
   ORDER BY sequence
   LIMIT :limit;
   ```

   Verified: with a concurrent insert in flight, `max(sequence)` was 4 while the settled
   maximum was 3, so a cursor advanced on the settled read cannot skip the in-flight row.
   Rows at or above `xmin` are deliberately left for the next poll; they arrive live via
   their own notification in the meantime.

Phase 2 should implement mitigation 1 with `xact_id` stored from the start, and add the
watermark query when replay lands. Storing the column early avoids a migration on a table
that may already be large.

### Batching a pointer read

A busy channel delivers many pointers in quick succession, and one `SELECT` per pointer
is the read amplification that makes pointers look slow. Coalesce instead: collect
pointer ids on the notification callback, then flush on the next tick (Node
`setImmediate` / `queueMicrotask`, Python `call_soon`) with one query.

```sql
SELECT sequence, message_id, envelope
FROM dbx_message_bus.open_messages
WHERE channel = $1 AND sequence = ANY($2::bigint[]);
```

This is a coalescing buffer, NOT a time window: the flush boundary is an event-loop tick,
and every id collected is read exactly once. Nothing is lost if the flush is late, because
membership in the batch is explicit rather than time-derived. A single missing row is a
real error worth reporting to `onError` — under the commit rule above, a pointer's row is
always readable by the time the notification arrives.

## Storage schema

Both tables share one column layout. Generate them from one definition so the tiers
cannot drift:

```sql
CREATE SCHEMA IF NOT EXISTS dbx_message_bus;

CREATE TABLE IF NOT EXISTS dbx_message_bus.open_messages (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel TEXT NOT NULL,
  topic TEXT NOT NULL,
  message_id TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  -- Inserting transaction, so a catch-up reader can tell settled rows from
  -- rows whose transaction may still be in flight. See the notification section.
  xact_id XID8 NOT NULL DEFAULT pg_current_xact_id(),
  envelope JSONB NOT NULL,
  UNIQUE (channel, message_id),
  CHECK (jsonb_typeof(envelope) = 'object')
);

CREATE TABLE IF NOT EXISTS dbx_message_bus.restricted_messages (
  LIKE dbx_message_bus.open_messages INCLUDING ALL
);

CREATE INDEX IF NOT EXISTS open_messages_replay_idx
  ON dbx_message_bus.open_messages (channel, topic, sequence);

CREATE INDEX IF NOT EXISTS open_messages_expiry_idx
  ON dbx_message_bus.open_messages (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS restricted_messages_replay_idx
  ON dbx_message_bus.restricted_messages (channel, topic, sequence);

CREATE INDEX IF NOT EXISTS restricted_messages_expiry_idx
  ON dbx_message_bus.restricted_messages (expires_at)
  WHERE expires_at IS NOT NULL;
```

`LIKE ... INCLUDING ALL` copies the identity column, defaults, `CHECK` constraint,
primary key, and the `UNIQUE (channel, message_id)` index, so the second table needs no
repeated column list at creation time. Verified on PostgreSQL 16: `restricted_messages`
comes out with its own `restricted_messages_sequence_seq`, `restricted_messages_pkey`, and
`restricted_messages_channel_message_id_key`.

Even so, the migrator should emit each tier's DDL from the same internal template rather
than defining one table in terms of the other. `LIKE` copies structure once at creation
and does not keep the tables in sync afterward, so a later column addition must be
applied to both explicitly.

Deliberately NOT a `scope` column on one shared table. A column would make isolation
depend on every query remembering a predicate, and a single missed `WHERE` would return
restricted rows to an open reader. A separate table makes the same mistake a
permission error instead of a data leak.

Deliberately NOT a partitioned table with one partition per tier either. Partitions of
one parent are convenient to query together, which is exactly the property that would
let an open reader select restricted rows through the parent.

Store the complete wire envelope in `envelope` rather than splitting `type`,
`metadata`, and `body` into separate authoritative columns. The routing, ordering,
and lifecycle fields are duplicated as typed columns because they are queried and
indexed. The JSON envelope remains the source returned to callers, which avoids a
storage migration whenever an optional envelope field is added.

Use `TEXT` for `message_id`, not PostgreSQL `UUID`. Node currently creates ids through
`hash.id()` and Python through `uuid.uuid4()`; the public contract promises a string,
not a UUID forever.

The resolved table name must come from the tier enum, never from caller input. Map
`"open"` and `"restricted"` onto the configured identifiers and reject anything else, so
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
published to, so a process holding only the open grant never needs privileges on the
restricted table to publish or to clean up. That is what keeps the two grants genuinely
independent.

Note that `LISTEN` / `NOTIFY` is not tier-aware: the channel is shared, so any session
listening on it still receives a restricted message live. Persistence tiers govern STORED
access, not live fan-out. Give restricted traffic its own `channel` when live delivery
must also be separated, and say so plainly in the README.

The cleanup should be bounded so one publish cannot inherit an unbounded deletion:

```sql
WITH expired AS (
  SELECT ctid
  FROM dbx_message_bus.open_messages
  WHERE expires_at IS NOT NULL
    AND expires_at <= clock_timestamp()
  ORDER BY expires_at
  LIMIT $1
)
DELETE FROM dbx_message_bus.open_messages AS messages
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
half-installed schema is the failure mode where a restricted publisher works locally and
then finds no restricted table in production. Provisioning is an administrative act, so it
should produce the complete installation; a runtime role that lacks the restricted grant
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
CREATE ROLE dbx_message_bus_open NOLOGIN;
CREATE ROLE dbx_message_bus_restricted NOLOGIN;

-- Schema USAGE is required by both tiers and grants nothing on its own.
GRANT USAGE ON SCHEMA dbx_message_bus TO dbx_message_bus_open, dbx_message_bus_restricted;

GRANT SELECT, INSERT, DELETE ON TABLE dbx_message_bus.open_messages
  TO dbx_message_bus_open;

GRANT SELECT, INSERT, DELETE ON TABLE dbx_message_bus.restricted_messages
  TO dbx_message_bus_restricted;
```

No sequence grant is required, and none should be issued. `GENERATED ALWAYS AS IDENTITY`
owns its sequence implicitly, so `INSERT` privilege on the table is sufficient — verified
on PostgreSQL 16 by inserting as a role holding only `SELECT, INSERT, DELETE`. This is
the practical difference from a `serial` column, which does require
`GRANT USAGE ON SEQUENCE`; do not copy that habit here.

The restricted role is NOT a superset of the open role by default. Keep the tiers
independent and grant both memberships when an identity needs both, so "may read
restricted traffic" never silently implies anything about open traffic:

```sql
GRANT dbx_message_bus_open TO "452f8cc3-d3c5-450c-8671-967263a92a2d";
GRANT dbx_message_bus_restricted TO "452f8cc3-d3c5-450c-8671-967263a92a2d";
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
- tier-to-table resolution for both `"open"` and `"restricted"`;
- the default tier being `"open"`;
- per-message tier override precedence over the bus default;
- cursor ordering and pagination boundaries;
- cursor tier tagging and rejection of a cursor from the other tier;
- pointer payload shape and its version field;
- pointer-versus-envelope selection per bus and per message;
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
- pointer reads coalescing into one batched query per tick;
- a pointer whose row is missing reporting to `onError` rather than throwing;
- a settled-watermark read refusing to advance past an in-flight transaction;
- an out-of-order commit still delivering the lower `sequence` to a live listener;
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
   Store `xact_id` from the first migration so no later backfill is needed.
4. Add tier-aware `history` and `cleanupExpired`.
5. Add `payload: "pointer"` with a coalesced batch read.
6. Port the same behavior to Python and add polyglot fixtures.
7. Update both package READMEs to distinguish live-only from persisted modes, and the
   open tier from the restricted tier, including the fact that live `NOTIFY` fan-out is not
   tier-aware.

### Phase 2: replay subscription

1. Add opaque, tier-tagged cursors to history results.
2. Establish `LISTEN` before querying history.
3. Buffer live messages during replay.
4. Deduplicate persisted and buffered messages by id.
5. Advance catch-up cursors only to the settled `xmin` watermark.
6. Document at-least-once replay behavior and listener idempotency.

### Phase 3: operations

1. Add per-tier table-size, expired-row, and oldest-message inspection queries.
2. Document autovacuum and maintenance-job guidance for high-volume buses.
3. Consider partitioning only after measured table volume justifies it.
4. Revisit RLS only with a concrete multi-tenant authorization requirement.

## Explicit non-goals

- No competing-consumer queue, acknowledgements, leases, or retries.
- No exactly-once delivery promise.
- No time-window reads. The id is the cursor; a `last 5ms` window loses rows.
- No table per topic, channel, or bus instance.
- No third access tier, and no caller-defined tier names.
- No `scope` column standing in for the two tables.
- No tier-aware live `LISTEN` / `NOTIFY` delivery.
- No implicit restricted access for a role holding only the open grant.
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
5. Tier names are settled: `"open"` / `"restricted"`, chosen so neither collides with
   PostgreSQL's `PUBLIC` role, which these grants deliberately avoid.
6. Decide whether the restricted tier should also carry a default TTL shorter than 24 hours,
   since restricted payloads are the ones a deployment is most likely to want retained
   briefly.
7. Decide whether `payload: "pointer"` should become the default for the restricted tier,
   since it keeps restricted bodies out of a channel every listener can hear.

## Verified against PostgreSQL 16

The SQL in this document was executed against a throwaway PostgreSQL 16 cluster rather
than written from memory. What the run established:

- the two-table DDL and both partial expiry indexes apply cleanly, and
  `LIKE ... INCLUDING ALL` reproduces the identity column, constraints, and indexes under
  tier-prefixed names;
- a role holding only `SELECT, INSERT, DELETE` on a tier table can insert into the
  `GENERATED ALWAYS AS IDENTITY` column with NO sequence grant;
- a open-tier-only role is denied both `SELECT` and `INSERT` on `restricted_messages`,
  which is the isolation claim the two-table split exists to make;
- a role holding both group memberships reads both tables;
- the history predicate hides expired rows before any deletion runs;
- the bounded cleanup deletes exactly its `LIMIT` and leaves the remaining expired rows
  for the next call;
- the cleanup query plans as an index scan on the partial expiry index.

A second run covered notification-driven reads:

- `NOTIFY` from an open transaction delivered NOTHING to a listening session until that
  transaction committed, which is what makes a pointer safe: the row is readable whenever
  its pointer arrives;
- a row inserted before another but committed after it became visible BEHIND the reader's
  cursor, and a `sequence > cursor` poll then returned zero rows — the skip that rules out
  a bare incrementing cursor for catch-up reads;
- with one insert still in flight, visible `max(sequence)` was 4 while the settled
  maximum under `xact_id < pg_snapshot_xmin(pg_current_snapshot())` was 3, confirming the
  watermark holds the cursor back exactly far enough.

Email-shaped and UUID-shaped Databricks role names were used for the grant tests, since
those are the identities that require quoting in generated SQL.
