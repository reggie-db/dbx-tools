import { object } from "@dbx-tools/shared-core";
import type { QueryResultRow } from "pg";
import type { PgPoolLike, PgQueryable } from "./advisory-lock.ts";
import { withAdvisoryTransactionLock } from "./advisory-lock.ts";
import type { TopicMessage } from "./topic-bus.ts";

export type TopicPersistenceScope = "open" | "restricted";
export type DurationInput = string | number;
export interface TopicBusPersistenceOptions {
  schema?: string;
  scope?: TopicPersistenceScope;
  tables?: Partial<Record<TopicPersistenceScope, string>>;
  ttl?: DurationInput | false;
  payload?: "envelope" | "pointer";
  cleanupBatchSize?: number;
  provision?: boolean;
}
export interface ResolvedTopicBusPersistenceOptions {
  schema: string;
  scope: TopicPersistenceScope;
  tables: Record<TopicPersistenceScope, string>;
  ttl: DurationInput | false;
  payload: "envelope" | "pointer";
  cleanupBatchSize: number;
  provision: boolean;
}
export interface StoredTopicMessage<
  TBody extends object.SerializableValue = object.SerializableValue,
> {
  cursor: string;
  expiresAt: string | null;
  scope: TopicPersistenceScope;
  message: TopicMessage<TBody>;
}
export interface TopicHistoryPage<
  TBody extends object.SerializableValue = object.SerializableValue,
> {
  messages: StoredTopicMessage<TBody>[];
  nextCursor?: string;
}

const DEFAULT_TTL = "24 hours";
/**
 * Pointer-payload version. A listener that does not recognize the version treats
 * the notification as foreign traffic rather than guessing at its shape.
 */
export const POINTER_VERSION = 1;
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const table = (options: ResolvedTopicBusPersistenceOptions, scope: TopicPersistenceScope): string =>
  `${quote(options.schema)}.${quote(options.tables[scope])}`;

export function resolvePersistenceOptions(
  value: true | TopicBusPersistenceOptions,
): ResolvedTopicBusPersistenceOptions {
  const configured = value === true ? {} : value;
  const scope = configured.scope ?? "open";
  if (scope !== "open" && scope !== "restricted") {
    throw new TypeError(`Unknown persistence scope: ${String(scope)}`);
  }
  return {
    schema: configured.schema ?? "dbx_message_bus",
    scope,
    tables: {
      open: configured.tables?.open ?? "open_messages",
      restricted: configured.tables?.restricted ?? "restricted_messages",
    },
    ttl: configured.ttl ?? DEFAULT_TTL,
    payload: configured.payload ?? "envelope",
    cleanupBatchSize: configured.cleanupBatchSize ?? 1000,
    provision: configured.provision ?? true,
  };
}

export async function provisionMessageBusSchema(
  pool: PgPoolLike,
  options: ResolvedTopicBusPersistenceOptions,
): Promise<void> {
  await withAdvisoryTransactionLock(pool, ["dbx_message_bus", "schema"], async (client) => {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quote(options.schema)}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${quote(options.schema)}.${quote("schema_version")} (version INTEGER PRIMARY KEY)`,
    );
    for (const scope of ["open", "restricted"] as const) {
      const name = table(options, scope);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${name} (sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, channel TEXT NOT NULL, topic TEXT NOT NULL, message_id TEXT NOT NULL, published_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ, xact_id XID8 NOT NULL DEFAULT pg_current_xact_id(), envelope JSONB NOT NULL, UNIQUE (channel, message_id), CHECK (jsonb_typeof(envelope) = 'object'))`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${quote(`${options.tables[scope]}_replay_idx`)} ON ${name} (channel, topic, sequence)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${quote(`${options.tables[scope]}_expiry_idx`)} ON ${name} (expires_at) WHERE expires_at IS NOT NULL`,
      );
    }
    await client.query(
      `INSERT INTO ${quote(options.schema)}.${quote("schema_version")} (version) VALUES (1) ON CONFLICT (version) DO NOTHING`,
    );
  });
}

export function messageBusGrantStatements(
  roles: string | readonly string[],
  scope: TopicPersistenceScope,
  options: ResolvedTopicBusPersistenceOptions,
): string[] {
  const selected = table(options, scope);
  return (typeof roles === "string" ? [roles] : roles).flatMap((role) => [
    `GRANT USAGE ON SCHEMA ${quote(options.schema)} TO ${quote(role)};`,
    `GRANT SELECT, INSERT, DELETE ON TABLE ${selected} TO ${quote(role)};`,
    `GRANT SELECT ON TABLE ${quote(options.schema)}.${quote("schema_version")} TO ${quote(role)};`,
  ]);
}

function cursor(scope: TopicPersistenceScope, sequence: string | number): string {
  return Buffer.from(JSON.stringify([scope, String(sequence)])).toString("base64url");
}
function after(value: string | undefined, scope: TopicPersistenceScope): string {
  if (!value) return "0";
  const decoded = JSON.parse(Buffer.from(value, "base64url").toString()) as [string, string];
  if (decoded[0] !== scope) {
    throw new TypeError("History cursor belongs to another persistence scope");
  }
  return decoded[1];
}
export function ttlMilliseconds(value: DurationInput | false): number | null {
  if (value === false) return null;
  const milliseconds = object.toDuration(value);
  if (milliseconds === undefined || milliseconds <= 0) {
    throw new TypeError(`Invalid persistence TTL: ${String(value)}`);
  }
  return milliseconds;
}

export async function cleanupExpired(
  queryable: PgQueryable,
  options: ResolvedTopicBusPersistenceOptions,
  scope: TopicPersistenceScope,
  limit = options.cleanupBatchSize,
): Promise<number> {
  const result = await queryable.query(
    `WITH expired AS (SELECT ctid FROM ${table(options, scope)} WHERE expires_at IS NOT NULL AND expires_at <= clock_timestamp() ORDER BY expires_at LIMIT $1) DELETE FROM ${table(options, scope)} AS messages USING expired WHERE messages.ctid = expired.ctid`,
    [limit],
  );
  return result.rowCount ?? 0;
}

type HistoryRow = QueryResultRow & {
  sequence: string;
  expires_at: Date | string | null;
  envelope: TopicMessage;
};
export async function history<TBody extends object.SerializableValue>(
  queryable: PgQueryable,
  channel: string,
  topic: string,
  options: ResolvedTopicBusPersistenceOptions,
  input: { after?: string; limit?: number; scope?: TopicPersistenceScope } = {},
): Promise<TopicHistoryPage<TBody>> {
  const scope = input.scope ?? options.scope;
  const limit = input.limit ?? 100;
  const result = await queryable.query<HistoryRow>(
    `SELECT sequence, expires_at, envelope FROM ${table(options, scope)} WHERE channel = $1 AND topic = $2 AND sequence > $3::bigint AND (expires_at IS NULL OR expires_at > clock_timestamp()) ORDER BY sequence LIMIT $4`,
    [channel, topic, after(input.after, scope), limit],
  );
  const messages = result.rows.map((row) => ({
    cursor: cursor(scope, row.sequence),
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    scope,
    message: row.envelope as TopicMessage<TBody>,
  }));
  return {
    messages,
    ...(messages.length === limit ? { nextCursor: messages.at(-1)!.cursor } : {}),
  };
}

export async function persistedNotify(
  client: PgQueryable,
  channel: string,
  topic: string,
  message: TopicMessage,
  encoded: string,
  options: ResolvedTopicBusPersistenceOptions,
  scope: TopicPersistenceScope,
  ttl: DurationInput | false,
): Promise<void> {
  await cleanupExpired(client, options, scope);
  const milliseconds = ttlMilliseconds(ttl);
  const inserted = await client.query<QueryResultRow & { sequence: string }>(
    `INSERT INTO ${table(options, scope)} (channel, topic, message_id, published_at, expires_at, envelope) VALUES ($1, $2, $3, $4, CASE WHEN $5::bigint IS NULL THEN NULL ELSE clock_timestamp() + ($5::bigint * interval '1 millisecond') END, $6::jsonb) RETURNING sequence`,
    [channel, topic, message.id, message.publishedAt, milliseconds, encoded],
  );
  // The row and the notification commit together, so a pointer is never delivered
  // before the row it names is readable - `NOTIFY` is delivered at COMMIT, not at
  // statement time.
  const payload =
    options.payload === "pointer"
      ? pointerPayload(scope, topic, message.id, inserted.rows[0]?.sequence ?? "0")
      : encoded;
  await client.query("SELECT pg_notify($1, $2)", [channel, payload]);
}

/**
 * The `payload: "pointer"` notification body: routing and identity only, so the
 * size limit does not apply and a listener without the table grant learns that
 * something happened without learning what.
 */
export function pointerPayload(
  scope: TopicPersistenceScope,
  topic: string,
  id: string,
  sequence: string | number,
): string {
  return JSON.stringify({ v: POINTER_VERSION, scope, topic, id, sequence: String(sequence) });
}

/** A decoded pointer notification. */
export interface TopicPointer {
  scope: TopicPersistenceScope;
  topic: string;
  id: string;
  sequence: string;
}

/**
 * Read a notification as a pointer, or `undefined` when it is not one. The channel
 * is shared, so an unrecognized payload is ordinary traffic rather than an error.
 */
export function decodePointer(value: string | undefined): TopicPointer | undefined {
  if (!value) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const candidate = record as Record<string, unknown>;
  if (candidate.v !== POINTER_VERSION) return undefined;
  const { scope, topic, id, sequence } = candidate;
  if (scope !== "open" && scope !== "restricted") return undefined;
  if (typeof topic !== "string" || typeof id !== "string" || typeof sequence !== "string") {
    return undefined;
  }
  return { scope, topic, id, sequence };
}

/**
 * Fetch the one stored envelope a pointer names. Returns `undefined` when the row
 * is gone (TTL cleanup won the race) or the reader lacks the table's grant, both
 * of which are expected on the `restricted` tier rather than errors.
 */
export async function readPointer<TBody extends object.SerializableValue>(
  queryable: PgQueryable,
  channel: string,
  pointer: TopicPointer,
  options: ResolvedTopicBusPersistenceOptions,
): Promise<TopicMessage<TBody> | undefined> {
  const result = await queryable.query<QueryResultRow & { envelope: TopicMessage }>(
    `SELECT envelope FROM ${table(options, pointer.scope)} WHERE channel = $1 AND message_id = $2 AND (expires_at IS NULL OR expires_at > clock_timestamp())`,
    [channel, pointer.id],
  );
  return result.rows[0]?.envelope as TopicMessage<TBody> | undefined;
}
