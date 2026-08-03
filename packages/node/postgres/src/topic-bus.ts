/**
 * Topic fan-out over PostgreSQL `LISTEN`/`NOTIFY`, for telling every running
 * instance of an app that something happened.
 *
 * The sibling `advisory-lock` module is about making sure only ONE connection
 * does a thing; this one is the opposite - EVERY listening session gets every
 * notification. That makes it the right primitive for live UI updates
 * (an SSE stream per browser tab, a cache invalidation, a presence ping) and the
 * wrong one for work distribution: there are no competing consumers, no acks, and
 * no replay.
 *
 * Delivery is best-effort and live. `NOTIFY` reaches sessions that are listening
 * at the moment it commits, so a listener that connects a second later never sees
 * it, and a listener whose connection drops misses everything until the bus
 * reconnects. Use a table or a queue when a subscriber needs durability.
 *
 * ONE CHANNEL, MANY TOPICS. Every bus instance listens on a single Postgres
 * channel (`channel`, default `dbx_tools_topic_bus`) and filters by the
 * envelope's `topic` in-process, so adding a topic costs no connection and no
 * `LISTEN`. The tradeoff is that every listening session decodes every message on
 * the channel; give a genuinely high-volume, unrelated stream its own `channel`
 * rather than a topic.
 *
 * @module
 */

import { hostname } from "node:os";
import { async as asyncUtil, error, hash, json, string } from "@dbx-tools/shared-core";
import type { Notification, PoolClient } from "pg";

import type { PgPoolLike, PgQueryable } from "./advisory-lock.ts";

const DEFAULT_CHANNEL = "dbx_tools_topic_bus";
/**
 * Encoded-envelope ceiling. PostgreSQL caps a `NOTIFY` payload at 8000 bytes and
 * fails the statement past that, so the bus rejects the message first with a size
 * it can name. The margin below 8000 covers the server's own accounting.
 */
const MAX_NOTIFY_BYTES = 7_900;
const MIN_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;

/**
 * The subset of AppKit's per-request execution context the bus reads for sender
 * identity. Fields are `unknown` because this is a structural view of an OPTIONAL
 * peer: the values are trimmed and validated rather than trusted.
 */
type AppKitExecutionContext = {
  userEmail?: unknown;
  userId?: unknown;
  userName?: unknown;
};

/** Structural view of `@databricks/appkit`, imported lazily and never required. */
type AppKitModule = {
  getExecutionContext(): AppKitExecutionContext;
};

/**
 * Cached result of the one optional-peer import, resolved to `undefined` when
 * AppKit is not installed. Memoized so a bus in a plain Postgres process pays for
 * the failed resolution once instead of per broadcast.
 */
let appKitModule: Promise<AppKitModule | undefined> | undefined;

/** A JSON scalar. `undefined` is deliberately absent - `JSON.stringify` drops it. */
export type SerializablePrimitive = string | number | boolean | null;

/**
 * Any value that survives a `JSON.stringify`/`JSON.parse` round trip unchanged.
 *
 * The bus takes this rather than `unknown` so a `Date`, a `Map`, or a class
 * instance is a compile error at the call site instead of a listener that quietly
 * receives a string or `{}`. {@link isSerializableValue} is the runtime half.
 */
export type SerializableValue =
  SerializablePrimitive | SerializableValue[] | { [key: string]: SerializableValue };

/**
 * Flat-keyed context travelling alongside a message body: who sent it, from
 * where, in which deployment. Values may nest, but the keys are the addressable
 * part - a listener filtering or labelling messages reads `metadata.user`, not a
 * path into the body.
 */
export type TopicMetadata = Record<string, SerializableValue>;

/**
 * True when `value` survives a JSON round trip with no loss and no coercion.
 *
 * Stricter than "`JSON.stringify` did not throw", because that succeeds while
 * silently changing the value: a `Date` becomes a string, `NaN` and `Infinity`
 * become `null`, a `Map` becomes `{}`, and `undefined` disappears from an object
 * or turns into `null` inside an array. Each of those reaches the listener as
 * something other than what was sent, so all of them are rejected here.
 *
 * Rejected: non-finite numbers, `undefined`, functions, symbols, bigints, class
 * instances and anything else with a prototype other than `Object.prototype` or
 * `null` (`Date`, `Map`, `Set`, `RegExp`, `Buffer`), and any object graph
 * containing a cycle. Accepted: strings, booleans, `null`, finite numbers, plain
 * objects, arrays, and nestings of those.
 *
 * Also the validator for untrusted input - a request body or a decoded `NOTIFY`
 * payload - since it narrows to {@link SerializableValue} instead of asserting.
 * Never throws.
 *
 * @param ancestors Cycle-detection set for the recursive walk. Internal; callers
 *   pass one value.
 */
export function isSerializableValue(
  value: unknown,
  ancestors: Set<object> = new Set(),
): value is SerializableValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isSerializableValue(entry, ancestors))
    : Object.values(value).every((entry) => isSerializableValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

/**
 * The wire envelope every subscriber receives, and what {@link
 * PostgresTopicBus.broadcast} returns to the publisher.
 *
 * `id`, `topic`, and `publishedAt` are assigned by the bus; `type`, `metadata`,
 * and `body` come from the caller (with automatic context merged under
 * `metadata`). The shape is stable enough to hand straight to an SSE `data:`
 * frame.
 */
export interface TopicMessage<TBody extends SerializableValue = SerializableValue> {
  /**
   * Per-message identity generated by the publisher, unique across instances.
   * Suitable for dedupe when a client reconnects and for an SSE `id:` field. Not
   * ordered, and not a database key.
   */
  id: string;
  /** The topic this was broadcast on; listeners on other topics never see it. */
  topic: string;
  /** Caller-chosen event name, e.g. `order.updated`. Never empty. */
  type: string;
  /** Automatic context merged with caller metadata. See {@link TopicMetadata}. */
  metadata: TopicMetadata;
  /** The caller's payload, unchanged. */
  body: TBody;
  /**
   * ISO-8601 publish time from the PUBLISHING process's clock, not the database's.
   * Fine for display; do not order messages from different instances by it.
   */
  publishedAt: string;
}

/** What a caller supplies to {@link PostgresTopicBus.broadcast}. */
export interface TopicPublishInput<TBody extends SerializableValue = SerializableValue> {
  /** Event name, e.g. `chat.message`. Must be non-blank. */
  type: string;
  /**
   * Context to attach. Wins over any automatic key of the same name, so a caller
   * can override a machine default (`project`) or add its own (`traceId`).
   */
  metadata?: TopicMetadata;
  /** The payload. Must satisfy {@link isSerializableValue}. */
  body: TBody;
}

/**
 * Subscriber callback. Invoked once per matching message on the notification
 * connection's callback, so it should not block: a returned promise is awaited
 * only to route a rejection to `onError`, and listeners for one message run
 * concurrently rather than in registration order.
 *
 * `TBody` is unchecked at runtime. The bus guarantees the body is serializable,
 * not that it matches the type parameter, so validate anything a listener
 * branches on.
 */
export type TopicListener<TBody extends SerializableValue = SerializableValue> = (
  message: TopicMessage<TBody>,
) => void | PromiseLike<void>;

/**
 * Resolves metadata at publish time instead of construction time, for context a
 * process learns late or asynchronously - a discovered public IP, an instance id
 * from a control plane. Called on every broadcast, so memoize anything expensive;
 * a rejection fails the broadcast.
 */
export type TopicMetadataProvider = () => TopicMetadata | PromiseLike<TopicMetadata>;

/** Construction options for {@link PostgresTopicBus}. */
export interface PostgresTopicBusOptions {
  /**
   * Postgres notification channel shared by every participating process, so all
   * of them must agree on it. Must be a valid unquoted-identifier-shaped name
   * (letter or `_`, then letters/digits/`_`, 63 chars max) or the constructor
   * throws `TypeError`. Defaults to `dbx_tools_topic_bus`.
   */
  channel?: string;
  /**
   * Extra context added to every message this bus publishes, either a fixed
   * record or a {@link TopicMetadataProvider} called per broadcast. Overrides
   * automatic machine keys; per-call `metadata` overrides this.
   */
  metadata?: TopicMetadata | TopicMetadataProvider;
  /**
   * Sink for failures that have no caller to throw to: a listener that rejected,
   * a dropped notification connection, a failed reconnect attempt. Defaults to
   * swallowing them, so wire this to a logger in anything long-running.
   */
  onError?: (cause: unknown) => void;
}

/**
 * Drop keys whose value is `undefined`, so an unset environment variable leaves
 * the key ABSENT rather than present-and-null. Absence is what lets caller
 * metadata and later merge layers supply the key instead.
 */
function definedMetadata(values: Record<string, SerializableValue | undefined>): TopicMetadata {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, SerializableValue] => {
      return entry[1] !== undefined;
    }),
  );
}

/**
 * Context every message gets for free: which project, host, process, and
 * deployment published it.
 *
 * Read fresh per broadcast rather than cached, because a long-lived process can
 * be re-parented (a deployment id appearing after boot). Keys that resolve to
 * nothing are omitted. Public IP is only read from the environment here - the bus
 * never makes a network call to discover it; a process that wants a discovered IP
 * passes a {@link TopicMetadataProvider}.
 *
 * Deliberately NOT included: CPU architecture, runtime name, and runtime version.
 * They are constant per deployment and cost payload bytes against the `NOTIFY`
 * limit on every single message.
 */
function machineMetadata(): TopicMetadata {
  return definedMetadata({
    project:
      string.firstNonEmpty([
        process.env.DATABRICKS_APP_NAME,
        process.env.DATABRICKS_BUNDLE_NAME,
        process.env.PROJECT_NAME,
        process.env.npm_package_name,
      ]) ?? undefined,
    publicIp:
      string.firstNonEmpty([
        process.env.PUBLIC_IP,
        process.env.DATABRICKS_PUBLIC_IP,
        process.env.HOST_IP,
      ]) ?? undefined,
    hostname: hostname(),
    cwd: process.cwd(),
    platform: process.platform,
    pid: process.pid,
    environment: string.trimToNull(process.env.NODE_ENV) ?? undefined,
    appName: string.trimToNull(process.env.DATABRICKS_APP_NAME) ?? undefined,
    deploymentId: string.trimToNull(process.env.DATABRICKS_APP_DEPLOYMENT_ID) ?? undefined,
    databricksHost: string.trimToNull(process.env.DATABRICKS_HOST) ?? undefined,
  });
}

/**
 * Identity of the signed-in user on whose behalf this broadcast happens, when the
 * process can tell.
 *
 * `@databricks/appkit` is an OPTIONAL peer, so the import is lazy and a missing
 * module is not an error - this is a plain Postgres package that adds sender
 * identity when it happens to run inside an AppKit app. Outside an active
 * per-request execution context AppKit throws, which means "no user here", so the
 * result is empty metadata rather than a failed broadcast.
 */
async function senderMetadata(): Promise<TopicMetadata> {
  appKitModule ??= import("@databricks/appkit")
    .then((module) => module as AppKitModule)
    .catch(() => undefined);
  const appkit = await appKitModule;
  if (!appkit) return {};
  try {
    const context = appkit.getExecutionContext();
    return definedMetadata({
      senderId: string.trimToNull(context.userId) ?? undefined,
      senderName: string.trimToNull(context.userName) ?? undefined,
      senderEmail: string.trimToNull(context.userEmail) ?? undefined,
    });
  } catch {
    return {};
  }
}

/**
 * Validate a channel name at CONSTRUCTION so a bad one fails at startup rather
 * than on the first broadcast. The pattern is Postgres's unquoted identifier
 * shape within `NAMEDATALEN - 1`; longer names would be silently truncated by the
 * server, which would split publishers and listeners onto different channels.
 */
function channelName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) {
    throw new TypeError("Postgres notification channel must be a valid identifier");
  }
  return value;
}

/** Quote a validated channel for `LISTEN`/`UNLISTEN`, which take no parameters. */
function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Parse a `NOTIFY` payload into an envelope, returning `undefined` for anything
 * that is not one.
 *
 * The channel is shared and any Postgres session can `pg_notify` on it, so an
 * unrecognized payload is expected input, not an exception. Publishers run this
 * over their own encoded message too, which is how a body that stringifies but
 * does not round-trip is caught before it ships.
 */
function decode(value: string | undefined): TopicMessage | undefined {
  if (!value) return undefined;
  const record = json.parseRecord(value);
  if (
    !record ||
    typeof record.id !== "string" ||
    typeof record.topic !== "string" ||
    typeof record.type !== "string" ||
    typeof record.publishedAt !== "string" ||
    !record.metadata ||
    typeof record.metadata !== "object" ||
    Array.isArray(record.metadata) ||
    !("body" in record) ||
    !isSerializableValue(record.metadata) ||
    !isSerializableValue(record.body)
  ) {
    return undefined;
  }
  return {
    id: record.id,
    topic: record.topic,
    type: record.type,
    metadata: record.metadata as TopicMetadata,
    body: record.body as SerializableValue,
    publishedAt: record.publishedAt,
  };
}

/**
 * Broadcasts structured messages by topic and delivers them to every process
 * listening on the same channel.
 *
 * CONNECTION SHAPE. Publishing borrows a pooled connection per call, like any
 * other query. Listening cannot: `LISTEN` is session state, so the bus holds ONE
 * dedicated client out of the pool for as long as it has subscribers, no matter
 * how many topics or listeners are registered. Size the pool with that one
 * long-lived checkout in mind.
 *
 * LIFECYCLE. Construction is inert - nothing connects until the first
 * {@link listen} (or an explicit {@link start}). {@link close} is required to give
 * the connection back; a closed bus stays closed and throws on further use rather
 * than silently reconnecting. Register it with the host's shutdown hook.
 *
 * FAILURE HANDLING. A lost notification connection reconnects on its own with
 * bounded backoff while subscribers remain, reporting each failed attempt through
 * `onError`. Messages published during the gap are lost - `NOTIFY` has no replay.
 * A throwing or rejecting listener never affects the publisher or the other
 * listeners; its failure goes to `onError`.
 *
 * Not safe to share one instance across unrelated channels - construct one bus
 * per channel.
 */
export class PostgresTopicBus {
  private readonly channel: string;
  private readonly metadata: TopicMetadata | TopicMetadataProvider | undefined;
  private readonly onError: (cause: unknown) => void;
  private readonly listeners = new Map<string, Set<TopicListener>>();
  private client: PoolClient | undefined;
  private starting: Promise<void> | undefined;
  private reconnecting: Promise<void> | undefined;
  private readonly reconnectAbort = new AbortController();
  private closed = false;

  constructor(
    private readonly pool: PgPoolLike & PgQueryable,
    options: PostgresTopicBusOptions = {},
  ) {
    this.channel = channelName(options.channel ?? DEFAULT_CHANNEL);
    this.metadata = options.metadata;
    this.onError = options.onError ?? (() => undefined);
  }

  /**
   * Open the dedicated notification connection and `LISTEN`.
   *
   * Idempotent, and safe to call concurrently - overlapping calls await the same
   * in-flight connect. {@link listen} calls this, so it is only needed to surface
   * a connection problem at startup rather than on first subscribe. Throws if the
   * bus is closed, or if the pool cannot hand out a connection.
   */
  async start(): Promise<void> {
    if (this.client) return;
    if (this.closed) throw new Error("Postgres topic bus is closed");
    this.starting ??= this.connect().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }

  /**
   * Publish a message to `topic`, returning the envelope that was sent.
   *
   * Resolves once Postgres has accepted the `NOTIFY`, which says nothing about
   * anyone receiving it: sessions not listening at that moment miss it. Publishing
   * needs no {@link start} and no subscribers.
   *
   * Validation is deliberately front-loaded, since a message that fails on the
   * wire is far harder to diagnose than one rejected at the call: `TypeError` for a
   * blank topic or type, or a body/metadata that would not round-trip through JSON
   * unchanged ({@link isSerializableValue}); `RangeError` when the encoded
   * envelope exceeds the `NOTIFY` payload limit, which the automatic metadata
   * counts against - send a reference and let the receiver fetch the payload.
   * Throws if the bus is closed.
   */
  async broadcast<TBody extends SerializableValue>(
    topic: string,
    input: TopicPublishInput<TBody>,
  ): Promise<TopicMessage<TBody>> {
    if (!topic.trim()) throw new TypeError("Topic must not be empty");
    if (!input.type.trim()) throw new TypeError("Message type must not be empty");
    if (!isSerializableValue(input.metadata ?? {}) || !isSerializableValue(input.body)) {
      throw new TypeError("Message metadata and body must be JSON serializable without coercion");
    }
    if (this.closed) throw new Error("Postgres topic bus is closed");
    const automatic = await this.resolveMetadata();
    const message: TopicMessage<TBody> = {
      id: hash.id(),
      topic,
      type: input.type,
      metadata: { ...automatic, ...input.metadata },
      body: input.body,
      publishedAt: new Date().toISOString(),
    };
    let encoded: string;
    try {
      encoded = JSON.stringify(message);
    } catch (cause) {
      throw new TypeError(`Message must be JSON serializable: ${error.errorMessage(cause)}`);
    }
    if (!decode(encoded)) {
      throw new TypeError("Message type, metadata, and body must be JSON serializable");
    }
    if (Buffer.byteLength(encoded, "utf8") > MAX_NOTIFY_BYTES) {
      throw new RangeError(`Postgres notification exceeds ${MAX_NOTIFY_BYTES} bytes`);
    }
    await this.pool.query("SELECT pg_notify($1, $2)", [this.channel, encoded]);
    return message;
  }

  /**
   * Subscribe to `topic`, returning the function that unsubscribes.
   *
   * Connects on first use. Several listeners may share a topic; each is called
   * once per message. Only messages published AFTER this resolves arrive, so
   * subscribe before triggering whatever you expect to observe.
   *
   * The returned function removes just this listener and is safe to call twice.
   * The connection stays open once the last listener leaves - {@link close}
   * releases it - so a bus that subscribes and unsubscribes per request does not
   * churn connections.
   */
  async listen<TBody extends SerializableValue>(
    topic: string,
    listener: TopicListener<TBody>,
  ): Promise<() => Promise<void>> {
    if (!topic.trim()) throw new TypeError("Topic must not be empty");
    await this.start();
    const listeners = this.listeners.get(topic) ?? new Set<TopicListener>();
    listeners.add(listener as TopicListener);
    this.listeners.set(topic, listeners);
    return async () => {
      listeners.delete(listener as TopicListener);
      if (listeners.size === 0) this.listeners.delete(topic);
    };
  }

  /**
   * Build the automatic half of a message's metadata.
   *
   * Precedence, weakest first: machine/process context, then AppKit sender
   * identity, then this bus's configured metadata. The caller's per-message
   * metadata is layered over the result in {@link broadcast}, so the most specific
   * source always wins and nothing here can overwrite an explicit key.
   */
  private async resolveMetadata(): Promise<TopicMetadata> {
    const sender = await senderMetadata();
    const configured =
      typeof this.metadata === "function" ? await this.metadata() : (this.metadata ?? {});
    return { ...machineMetadata(), ...sender, ...configured };
  }

  /**
   * Release the notification connection and stop delivering messages. Idempotent.
   *
   * Cancels any pending reconnect, drops all listeners, then `UNLISTEN`s and
   * returns the client to the pool. A failed `UNLISTEN` is reported to the pool as
   * a release error so the connection is DISCARDED rather than handed to the next
   * caller still subscribed to the channel. Does not throw; the bus stays closed.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.reconnectAbort.abort(new Error("Postgres topic bus is closed"));
    await this.starting?.catch(() => undefined);
    await this.reconnecting?.catch(() => undefined);
    const client = this.client;
    this.client = undefined;
    this.listeners.clear();
    if (!client) return;
    client.removeListener("notification", this.handleNotification);
    client.removeListener("error", this.handleClientError);
    let releaseError: Error | undefined;
    try {
      await client.query(`UNLISTEN ${quoteIdentifier(this.channel)}`);
    } catch (cause) {
      releaseError = error.toError(cause);
    }
    client.release(releaseError);
  }

  /**
   * Check out one client, attach the handlers, and `LISTEN`.
   *
   * The handlers are attached BEFORE the `LISTEN` round trip so a notification or
   * error arriving mid-setup is not missed. Any failure - including the bus being
   * closed while the connect was in flight - detaches the handlers and releases
   * the client as errored, so a half-configured connection never returns to the
   * pool.
   */
  private async connect(): Promise<void> {
    const client = await this.pool.connect();
    try {
      client.on("notification", this.handleNotification);
      client.on("error", this.handleClientError);
      await client.query(`LISTEN ${quoteIdentifier(this.channel)}`);
      if (this.closed) throw new Error("Postgres topic bus is closed");
      this.client = client;
    } catch (cause) {
      client.removeListener("notification", this.handleNotification);
      client.removeListener("error", this.handleClientError);
      client.release(error.toError(cause));
      throw cause;
    }
  }

  /**
   * Route one inbound notification to the topic's listeners.
   *
   * Ignores other channels and undecodable payloads - the channel is shared, so
   * both are ordinary traffic. Listeners are invoked concurrently and their
   * rejections go to `onError`, keeping one slow or broken subscriber from
   * stalling the notification connection.
   */
  private readonly handleNotification = (notification: Notification): void => {
    if (notification.channel !== this.channel) return;
    const message = decode(notification.payload);
    if (!message) return;
    for (const listener of this.listeners.get(message.topic) ?? []) {
      Promise.resolve(listener(message)).catch(this.onError);
    }
  };

  /**
   * Handle the notification connection dying, which `pg` reports as an `error`
   * event rather than a rejected query.
   *
   * The client is unusable at this point, so it is detached and released as
   * errored (which discards it) before anything else. Reconnection only starts
   * when there is still someone to deliver to, so an idle or closing bus does not
   * hold a connection open chasing a channel nobody reads.
   */
  private readonly handleClientError = (cause: Error): void => {
    this.onError(cause);
    const client = this.client;
    if (!client) return;
    this.client = undefined;
    client.removeListener("notification", this.handleNotification);
    client.removeListener("error", this.handleClientError);
    client.release(cause);
    if (this.closed || this.listeners.size === 0) return;
    this.reconnecting ??= this.reconnect().finally(() => {
      this.reconnecting = undefined;
    });
  };

  /**
   * Re-establish the notification connection with bounded exponential backoff.
   *
   * The first attempt is immediate, since the common case is a single dropped
   * connection that reconnects at once; subsequent delays double from 250ms up to
   * 5s and stay there. Retries indefinitely rather than giving up, because a Postgres restart
   * or a rotated Lakebase credential is a recoverable outage and a silently dead
   * listener is worse than a noisy one. Stops when the bus closes or the last
   * listener leaves, and reports every failed attempt through `onError`.
   */
  private async reconnect(): Promise<void> {
    let delay = 0;
    while (!this.closed && this.listeners.size > 0) {
      if (delay > 0) {
        try {
          await asyncUtil.sleep(delay, this.reconnectAbort.signal);
        } catch {
          return;
        }
      }
      try {
        await this.start();
        return;
      } catch (cause) {
        if (this.closed) return;
        this.onError(cause);
        delay = delay === 0 ? MIN_RECONNECT_DELAY_MS : Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
      }
    }
  }
}
