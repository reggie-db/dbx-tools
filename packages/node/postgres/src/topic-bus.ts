/** Topic-based process fan-out over PostgreSQL LISTEN/NOTIFY. @module */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Notification, PoolClient } from "pg";

import { error, json, string } from "@dbx-tools/shared-core";

import type { PgPoolLike, PgQueryable } from "./advisory-lock.ts";

const DEFAULT_CHANNEL = "dbx_tools_topic_bus";
const MAX_NOTIFY_BYTES = 7_900;

type AppKitExecutionContext = {
  userEmail?: unknown;
  userId?: unknown;
  userName?: unknown;
};

type AppKitModule = {
  getExecutionContext(): AppKitExecutionContext;
};

let appKitModule: Promise<AppKitModule | undefined> | undefined;

export type SerializablePrimitive = string | number | boolean | null;
export type SerializableValue =
  SerializablePrimitive | SerializableValue[] | { [key: string]: SerializableValue };
export type TopicMetadata = Record<string, SerializableValue>;

export interface TopicMessage<TBody extends SerializableValue = SerializableValue> {
  id: string;
  topic: string;
  type: string;
  metadata: TopicMetadata;
  body: TBody;
  publishedAt: string;
}

export interface TopicPublishInput<TBody extends SerializableValue = SerializableValue> {
  type: string;
  metadata?: TopicMetadata;
  body: TBody;
}

export type TopicListener<TBody extends SerializableValue = SerializableValue> = (
  message: TopicMessage<TBody>,
) => void | PromiseLike<void>;

export type TopicMetadataProvider = () => TopicMetadata | PromiseLike<TopicMetadata>;

export interface PostgresTopicBusOptions {
  channel?: string;
  metadata?: TopicMetadata | TopicMetadataProvider;
  onError?: (cause: unknown) => void;
}

function definedMetadata(values: Record<string, SerializableValue | undefined>): TopicMetadata {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, SerializableValue] => {
      return entry[1] !== undefined;
    }),
  );
}

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

function channelName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) {
    throw new TypeError("Postgres notification channel must be a valid identifier");
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

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
    !("body" in record)
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
 * Broadcast structured JSON messages by topic and listen on one dedicated pooled
 * connection. Every Postgres session listening on the configured channel sees
 * every notification; topic filtering happens in-process.
 */
export class PostgresTopicBus {
  private readonly channel: string;
  private readonly metadata: TopicMetadata | TopicMetadataProvider | undefined;
  private readonly onError: (cause: unknown) => void;
  private readonly listeners = new Map<string, Set<TopicListener>>();
  private client: PoolClient | undefined;
  private starting: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly pool: PgPoolLike & PgQueryable,
    options: PostgresTopicBusOptions = {},
  ) {
    this.channel = channelName(options.channel ?? DEFAULT_CHANNEL);
    this.metadata = options.metadata;
    this.onError = options.onError ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.client) return;
    if (this.closed) throw new Error("Postgres topic bus is closed");
    this.starting ??= this.connect();
    await this.starting;
  }

  async broadcast<TBody extends SerializableValue>(
    topic: string,
    input: TopicPublishInput<TBody>,
  ): Promise<TopicMessage<TBody>> {
    if (!topic.trim()) throw new TypeError("Topic must not be empty");
    if (!input.type.trim()) throw new TypeError("Message type must not be empty");
    if (this.closed) throw new Error("Postgres topic bus is closed");
    const automatic = await this.resolveMetadata();
    const message: TopicMessage<TBody> = {
      id: randomUUID(),
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

  private async resolveMetadata(): Promise<TopicMetadata> {
    const sender = await senderMetadata();
    const configured =
      typeof this.metadata === "function" ? await this.metadata() : (this.metadata ?? {});
    return { ...machineMetadata(), ...sender, ...configured };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.starting?.catch(() => undefined);
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

  private async connect(): Promise<void> {
    const client = await this.pool.connect();
    try {
      client.on("notification", this.handleNotification);
      client.on("error", this.handleClientError);
      await client.query(`LISTEN ${quoteIdentifier(this.channel)}`);
      this.client = client;
    } catch (cause) {
      client.removeListener("notification", this.handleNotification);
      client.removeListener("error", this.handleClientError);
      client.release(error.toError(cause));
      throw cause;
    }
  }

  private readonly handleNotification = (notification: Notification): void => {
    if (notification.channel !== this.channel) return;
    const message = decode(notification.payload);
    if (!message) return;
    for (const listener of this.listeners.get(message.topic) ?? []) {
      Promise.resolve(listener(message)).catch(this.onError);
    }
  };

  private readonly handleClientError = (cause: Error): void => {
    this.onError(cause);
  };
}
