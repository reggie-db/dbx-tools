import type { UIMessage } from "ai";
import { z } from "zod";

const DEFAULT_MAX_MESSAGES = 100;

/** Client-observed lifecycle timestamps stored with one browser-held message. */
export const BrowserMessageTimestampsSchema = z
  .object({
    createdAt: z.iso.datetime().describe("ISO-8601 time when the message turn started."),
    completedAt: z.iso
      .datetime()
      .optional()
      .describe("ISO-8601 time when the assistant response completed."),
  })
  .passthrough()
  .describe("Browser-persisted message lifecycle timestamps.");

/** Client-observed lifecycle timestamps stored with one browser-held message. */
export type BrowserMessageTimestamps = z.infer<typeof BrowserMessageTimestampsSchema>;

const StoredBrowserMessageSchema = z
  .object({
    id: z.string().min(1).describe("AI SDK UI message identifier."),
    role: z.enum(["system", "user", "assistant"]).describe("AI SDK UI message author role."),
    metadata: z
      .unknown()
      .optional()
      .describe("Message lifecycle timestamps plus any transport-owned metadata."),
    parts: z.array(z.unknown()).describe("AI SDK UI message content parts."),
  })
  .passthrough()
  .describe("Browser-persisted AI SDK UI message.");

const StoredBrowserTranscriptSchema = z
  .object({
    version: z
      .union([z.literal(1), z.literal(2)])
      .describe("Browser transcript storage format version."),
    messages: z
      .array(StoredBrowserMessageSchema)
      .describe("Chronological AI SDK UI messages for one thread."),
  })
  .strict()
  .describe("Browser-persisted Mastra conversation transcript.");

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Build the browser storage key for one resource-scoped Mastra thread. */
export function browserTranscriptStorageKey(
  basePath: string,
  agentId: string,
  threadId: string,
  resourceScope?: string,
): string {
  const prefix = `dbx-mastra-transcript:${basePath}:${agentId}:${encodeURIComponent(threadId)}`;
  return resourceScope ? `${prefix}:${encodeURIComponent(resourceScope)}` : prefix;
}

/** Restore a browser transcript, removing malformed data without failing the chat. */
export function readStoredBrowserTranscript(
  key: string,
  storage: StorageLike | undefined = browserStorage(),
): UIMessage[] {
  if (!storage) return [];
  try {
    const serialized = storage.getItem(key);
    if (!serialized) return [];
    const parsed = StoredBrowserTranscriptSchema.parse(JSON.parse(serialized));
    return parsed.messages as UIMessage[];
  } catch {
    try {
      storage.removeItem(key);
    } catch {}
    return [];
  }
}

/** Read validated lifecycle timestamps from one UI message. */
export function readBrowserMessageTimestamps(
  message: Pick<UIMessage, "metadata">,
): BrowserMessageTimestamps | undefined {
  const parsed = BrowserMessageTimestampsSchema.safeParse(message.metadata);
  return parsed.success ? parsed.data : undefined;
}

/** Add lifecycle timestamps without discarding transport-owned message metadata. */
export function withBrowserMessageTimestamps(
  message: UIMessage,
  timestamps: BrowserMessageTimestamps,
): UIMessage {
  const existing =
    message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
      ? message.metadata
      : {};
  const current = readBrowserMessageTimestamps(message);
  const next = BrowserMessageTimestampsSchema.parse({
    ...existing,
    ...timestamps,
    createdAt: current?.createdAt ?? timestamps.createdAt,
  });
  return { ...message, metadata: next };
}

/** Persist the newest browser-held messages for one thread on a best-effort basis. */
export function storeBrowserTranscript(
  key: string,
  messages: readonly UIMessage[],
  maxMessages = DEFAULT_MAX_MESSAGES,
  storage: StorageLike | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    if (messages.length === 0) {
      storage.removeItem(key);
      return;
    }
    const limit = Number.isFinite(maxMessages)
      ? Math.max(1, Math.floor(maxMessages))
      : DEFAULT_MAX_MESSAGES;
    storage.setItem(key, JSON.stringify({ version: 2, messages: messages.slice(-limit) }));
  } catch {
    // Storage can be blocked or full; the live in-memory transcript remains valid.
  }
}
