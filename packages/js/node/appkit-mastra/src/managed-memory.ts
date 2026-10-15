/**
 * Databricks Agent Sessions and Agent Memory adapters for Mastra.
 *
 * Agent Sessions implement Mastra's native `MemoryStorage` domain. Managed
 * memory search is exposed as a Mastra input processor, so relevant long-term
 * memory enters only the current model request and is not copied into message
 * history. Direct Genie chat can mirror completed turns into a managed session
 * for a memory pipeline while continuing to read visible history from Genie.
 *
 * @module
 */

import type { WorkspaceClient } from "@databricks/appkit";
import { databricks } from "@dbx-tools/appkit";
import { projectUtils } from "@dbx-tools/core";
import { errorUtils, hash, json, log, object, stringUtils } from "@dbx-tools/shared-core";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { StorageThreadType } from "@mastra/core/memory";
import type { InputProcessor } from "@mastra/core/processors";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import {
  MastraCompositeStore,
  MemoryStorage,
  type StorageListMessagesByResourceIdInput,
  type StorageListMessagesInput,
  type StorageListMessagesOutput,
  type StorageListThreadsInput,
  type StorageListThreadsOutput,
  type StorageCloneThreadInput,
  type StorageCopyThreadOutput,
} from "@mastra/core/storage";
import { z } from "zod";

import { databricksFetch, readResponseJson } from "./rest.ts";

const logger = log.logger("mastra/managed-memory");
const PAGE_SIZE = 100;
const AGENT_METADATA_KEY = "agent_id";
const TITLE_METADATA_KEY = "title";
const THREAD_METADATA_KEY = "thread_metadata";
const MESSAGE_ITEM_TYPE = "message";
const DELETE_ITEM_TYPE = "mastra_message_delete";
const MEMORY_CONTEXT_HEADING = "Relevant long-term memory";

/** Databricks managed memory configuration for the Mastra plugin. */
export interface ManagedMemoryOptions {
  /**
   * Existing Agent Session Store id or resource name. Defaults to the
   * normalized {@link projectUtils.name} value.
   */
  sessionStore?: string;
  /**
   * Existing Agent Memory Store id or resource name. Defaults to the same
   * project name; set `false` for sessions without long-term memory.
   */
  memoryStore?: string | false;
  /** Search settings applied once to each user turn. */
  recall?: false | { topK?: number; pathPrefix?: string };
  /**
   * Extract durable memory after each completed Mastra or direct Genie turn.
   * Defaults to `true` when a memory store is configured.
   */
  extractAfterTurn?: boolean | { instructions?: string };
}

/** Enable managed memory with project defaults or configure it explicitly. */
export type ManagedMemoryConfig = true | ManagedMemoryOptions;

/** Fully resolved managed-memory resource identifiers and behavior. */
export type ResolvedManagedMemoryOptions = Omit<
  ManagedMemoryOptions,
  "sessionStore" | "memoryStore"
> & {
  sessionStore: string;
  memoryStore?: string;
};

/** Resolve omitted store ids from the normalized project name. */
export function resolveManagedMemoryOptions(
  options: ManagedMemoryConfig,
): ResolvedManagedMemoryOptions {
  const project = agentStoreId(projectUtils.name());
  const configured = options === true ? {} : options;
  const { sessionStore, memoryStore, ...rest } = configured;
  return {
    ...rest,
    sessionStore: sessionStore?.trim() || project,
    ...(memoryStore === false ? {} : { memoryStore: memoryStore?.trim() || project }),
  };
}

const SessionSchema = z
  .object({
    session_id: z.string().describe("Session identifier."),
    actor_id: z.string().describe("Trusted application actor identifier."),
    parent_session_id: z.string().optional().describe("Immediate parent session identifier."),
    root_session_id: z.string().optional().describe("Top-level session identifier."),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .describe("Mutable session string labels."),
    create_time: z.string().describe("Session creation timestamp."),
    update_time: z.string().optional().describe("Session resource update timestamp."),
    last_activity_time: z.string().optional().describe("Last item mutation timestamp."),
    name: z.string().optional().describe("Session resource name."),
  })
  .loose()
  .describe("Databricks Agent Session.");
type AgentSession = z.infer<typeof SessionSchema>;

const ListSessionsResponseSchema = z
  .object({
    sessions: z.array(SessionSchema).optional().describe("Sessions in this page."),
    next_page_token: z.string().optional().describe("Next page token."),
  })
  .loose()
  .describe("Page of Databricks Agent Sessions.");

const SessionItemSchema = z
  .object({
    item_id: z.string().optional().describe("Service-assigned item identifier."),
    data: z.record(z.string(), z.unknown()).describe("Opaque JSON-compatible session item."),
    create_time: z.string().optional().describe("Server-assigned append timestamp."),
  })
  .loose()
  .describe("Databricks Agent Session item.");
type AgentSessionItem = z.infer<typeof SessionItemSchema>;

const ListSessionItemsResponseSchema = z
  .object({
    session_items: z.array(SessionItemSchema).optional().describe("Session items in this page."),
    next_page_token: z.string().optional().describe("Next page token."),
  })
  .loose()
  .describe("Page of Databricks Agent Session items.");

const AppendSessionItemsResponseSchema = z
  .object({
    session_items: z
      .array(SessionItemSchema)
      .optional()
      .describe("Items persisted by the append operation."),
  })
  .loose()
  .describe("Databricks Agent Session append response.");

const ManagedMemoryEntrySchema = z
  .object({
    name: z.string().optional().describe("Managed memory entry resource name."),
    actor_id: z.string().describe("Trusted application actor identifier."),
    session_id: z.string().optional().describe("Associated session identifier."),
    path: z.string().describe("Absolute memory path."),
    content: z.string().optional().describe("Memory content."),
    description: z.string().optional().describe("Memory retrieval description."),
    source_type: z.string().optional().describe("Entry writer type."),
    create_time: z.string().optional().describe("Entry creation timestamp."),
    update_time: z.string().optional().describe("Entry update timestamp."),
  })
  .loose()
  .describe("Databricks managed memory entry.");
/** Databricks managed memory entry. */
export type ManagedMemoryEntry = z.infer<typeof ManagedMemoryEntrySchema>;

const SearchMemoryResponseSchema = z
  .object({
    managed_memory_entries: z
      .array(ManagedMemoryEntrySchema)
      .optional()
      .describe("Compatibility list of matching entries."),
    results: z
      .array(
        z
          .object({
            managed_memory_entry: ManagedMemoryEntrySchema.describe("Matching memory entry."),
            score: z.number().optional().describe("BM25 relevance score."),
          })
          .loose(),
      )
      .optional()
      .describe("Ranked memory search results."),
  })
  .loose()
  .describe("Databricks managed memory search response.");

const ExtractMemoryResponseSchema = z
  .object({
    name: z.string().optional().describe("Extraction correlation identifier."),
    entries: z
      .array(ManagedMemoryEntrySchema)
      .optional()
      .describe("Entries written by the extraction."),
  })
  .loose()
  .describe("Databricks managed memory extraction response.");

const MemoryPipelineRunSchema = z
  .object({
    name: z.string().optional().describe("Memory pipeline run resource name."),
    state: z.string().optional().describe("Memory pipeline run state."),
  })
  .loose()
  .describe("Databricks Agent Memory Pipeline run.");
/** Databricks Agent Memory Pipeline run. */
export type MemoryPipelineRun = z.infer<typeof MemoryPipelineRunSchema>;

const StoredMessageSchema = z
  .object({
    type: z.literal(MESSAGE_ITEM_TYPE).describe("Mastra message item discriminator."),
    role: z
      .enum(["user", "assistant", "system", "signal"])
      .describe("SDK-native message role used by managed memory extraction."),
    content: z.string().describe("Plain text used by managed memory extraction."),
    mastra_message: z
      .object({
        id: z.string().describe("Mastra message identifier."),
        role: z.enum(["user", "assistant", "system", "signal"]).describe("Mastra message role."),
        createdAt: z.string().describe("Message creation timestamp."),
        threadId: z.string().optional().describe("Owning thread identifier."),
        resourceId: z.string().optional().describe("Owning resource identifier."),
        messageType: z.string().optional().describe("Optional Mastra message type."),
        content: z.record(z.string(), z.unknown()).describe("Mastra format-2 message content."),
      })
      .describe("Serialized Mastra database message."),
  })
  .describe("Mastra message stored as an Agent Session item.");

const DeletedMessageSchema = z
  .object({
    type: z.literal(DELETE_ITEM_TYPE).describe("Message tombstone discriminator."),
    message_id: z.string().describe("Deleted Mastra message identifier."),
  })
  .describe("Append-only deletion tombstone.");

/** Thin REST client for Databricks Agent Sessions and Agent Memory. */
export class ManagedAgentMemoryClient {
  readonly sessionStore: string;
  readonly memoryStore?: string;

  constructor(
    private readonly client: WorkspaceClient,
    options: Pick<ResolvedManagedMemoryOptions, "sessionStore" | "memoryStore">,
  ) {
    this.sessionStore = resourceId(options.sessionStore, "session-stores");
    this.memoryStore = options.memoryStore
      ? resourceId(options.memoryStore, "memory-stores")
      : undefined;
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<AgentSession | undefined> {
    try {
      return SessionSchema.parse(
        await this.request("GET", this.sessionPath(sessionId), undefined, signal),
      );
    } catch (error) {
      if (errorUtils.errorContext(error).hasStatusCode(404)) return undefined;
      throw error;
    }
  }

  async createSession(input: {
    sessionId: string;
    actorId: string;
    metadata?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<AgentSession> {
    return SessionSchema.parse(
      await this.request(
        "POST",
        `${this.sessionStorePath()}/sessions`,
        {
          query: { session_id: input.sessionId },
          payload: {
            actor_id: input.actorId,
            ...(input.metadata ? { metadata: input.metadata } : {}),
          },
        },
        input.signal,
      ),
    );
  }

  async updateSession(input: {
    sessionId: string;
    actorId: string;
    metadata: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<AgentSession> {
    return SessionSchema.parse(
      await this.request(
        "PATCH",
        this.sessionPath(input.sessionId),
        {
          query: { update_mask: "metadata" },
          payload: { actor_id: input.actorId, metadata: input.metadata },
        },
        input.signal,
      ),
    );
  }

  async deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.request("DELETE", this.sessionPath(sessionId), undefined, signal);
  }

  async listSessions(
    options: { actorId?: string; signal?: AbortSignal } = {},
  ): Promise<AgentSession[]> {
    const sessions: AgentSession[] = [];
    let pageToken: string | undefined;
    do {
      const response = ListSessionsResponseSchema.parse(
        await this.request(
          "GET",
          `${this.sessionStorePath()}/sessions`,
          {
            query: {
              page_size: PAGE_SIZE,
              order_by: "last_activity_time desc",
              ...(options.actorId ? { filter: `actor_id = ${filterString(options.actorId)}` } : {}),
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          },
          options.signal,
        ),
      );
      sessions.push(...(response.sessions ?? []));
      pageToken = response.next_page_token;
    } while (pageToken);
    return sessions;
  }

  async listSessionItems(sessionId: string, signal?: AbortSignal): Promise<AgentSessionItem[]> {
    const items: AgentSessionItem[] = [];
    let pageToken: string | undefined;
    do {
      const response = ListSessionItemsResponseSchema.parse(
        await this.request(
          "GET",
          `${this.sessionPath(sessionId)}/items`,
          {
            query: {
              page_size: PAGE_SIZE,
              order_by: "create_time asc",
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          },
          signal,
        ),
      );
      items.push(...(response.session_items ?? []));
      pageToken = response.next_page_token;
    } while (pageToken);
    return items;
  }

  async appendSessionItems(
    sessionId: string,
    data: Record<string, unknown>[],
    signal?: AbortSignal,
  ): Promise<AgentSessionItem[]> {
    const response = AppendSessionItemsResponseSchema.parse(
      await this.request(
        "POST",
        `${this.sessionPath(sessionId)}/items:append`,
        { payload: { items: data.map((item) => ({ data: item })) } },
        signal,
      ),
    );
    return response.session_items ?? [];
  }

  async searchMemory(input: {
    actorId: string;
    query: string;
    topK?: number;
    pathPrefix?: string;
    sessionId?: string;
    signal?: AbortSignal;
  }): Promise<ManagedMemoryEntry[]> {
    if (!this.memoryStore) return [];
    const response = SearchMemoryResponseSchema.parse(
      await this.request(
        "POST",
        `/api/2.0/agents/memory-stores/${encodeURIComponent(this.memoryStore)}/entries:search`,
        {
          payload: {
            actor_id: input.actorId,
            query: input.query,
            page_size: input.topK ?? 10,
            ...(input.pathPrefix ? { path_prefix: input.pathPrefix } : {}),
            ...(input.sessionId ? { session_id: input.sessionId } : {}),
          },
        },
        input.signal,
      ),
    );
    if (response.results) return response.results.map((result) => result.managed_memory_entry);
    return response.managed_memory_entries ?? [];
  }

  async createMemoryEntry(input: {
    actorId: string;
    path: string;
    content?: string;
    description?: string;
    sessionId?: string;
    entryId?: string;
    signal?: AbortSignal;
  }): Promise<ManagedMemoryEntry> {
    if (!this.memoryStore) throw new Error("memoryStore is required");
    return ManagedMemoryEntrySchema.parse(
      await this.request(
        "POST",
        `/api/2.0/agents/memory-stores/${encodeURIComponent(this.memoryStore)}/entries`,
        {
          ...(input.entryId ? { query: { managed_memory_entry_id: input.entryId } } : {}),
          payload: {
            actor_id: input.actorId,
            path: input.path,
            ...(input.content ? { content: input.content } : {}),
            ...(input.description ? { description: input.description } : {}),
            ...(input.sessionId ? { session_id: input.sessionId } : {}),
            source_type: "MANAGED_MEMORY_ENTRY_SOURCE_TYPE_AGENT",
          },
        },
        input.signal,
      ),
    );
  }

  async extractSession(input: {
    sessionId: string;
    instructions?: string;
    dryRun?: boolean;
    signal?: AbortSignal;
  }): Promise<ManagedMemoryEntry[]> {
    if (!this.memoryStore) return [];
    const response = ExtractMemoryResponseSchema.parse(
      await this.request(
        "POST",
        `${this.sessionPath(input.sessionId)}/extractions`,
        {
          payload: {
            memory_store: `memory-stores/${this.memoryStore}`,
            ...(input.instructions ? { instructions: input.instructions } : {}),
            ...(input.dryRun !== undefined ? { dry_run: input.dryRun } : {}),
          },
        },
        input.signal,
      ),
    );
    return response.entries ?? [];
  }

  async runMemoryPipeline(pipelineId: string, signal?: AbortSignal): Promise<MemoryPipelineRun> {
    const id = resourceId(pipelineId, "memory-pipelines");
    return MemoryPipelineRunSchema.parse(
      await this.request(
        "POST",
        `/api/2.0/agents/memory-pipelines/${encodeURIComponent(id)}/run`,
        { payload: {} },
        signal,
      ),
    );
  }

  private sessionStorePath(): string {
    return `/api/2.0/agents/session-stores/${encodeURIComponent(this.sessionStore)}`;
  }

  private sessionPath(sessionId: string): string {
    return `${this.sessionStorePath()}/sessions/${encodeURIComponent(sessionId)}`;
  }

  private request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options?: { query?: Record<string, string | number | boolean>; payload?: unknown },
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (method !== "PATCH") {
      return this.client.apiClient.request(
        {
          path,
          method,
          headers: new Headers({
            accept: "application/json",
            ...(options?.payload !== undefined ? { "content-type": "application/json" } : {}),
          }),
          raw: false,
          ...(options?.query ? { query: options.query } : {}),
          ...(options?.payload !== undefined ? { payload: options.payload } : {}),
        },
        signal ? databricks.toContext(signal) : undefined,
      );
    }
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(options?.query ?? {})) {
      query.set(name, String(value));
    }
    const requestPath = query.size > 0 ? `${path}?${query}` : path;
    return databricksFetch(this.client, requestPath, {
      method,
      ...(options?.payload !== undefined ? { body: options.payload } : {}),
      ...(signal ? { signal } : {}),
    }).then(async (response) => {
      const body = await readResponseJson(response);
      if (response.ok) return body;
      throw Object.assign(
        new Error(`Databricks Agent Memory request failed (${response.status})`),
        {
          statusCode: response.status,
          response: body,
        },
      );
    });
  }
}

/**
 * Mastra `MemoryStorage` backed by one Databricks Agent Session Store.
 *
 * Session items are append-only, so message updates and deletes append
 * replacement records or tombstones. Reads fold the log into Mastra's current
 * message view.
 */
export class ManagedSessionMemoryStorage extends MemoryStorage {
  readonly supportsPartialThreadUpdate = true;
  private readonly creating = new Map<string, Promise<AgentSession>>();
  private readonly writing = new Map<string, Promise<void>>();

  constructor(
    private readonly memory: ManagedAgentMemoryClient,
    private readonly agentId: string,
    private readonly extractAfterTurn: ManagedMemoryOptions["extractAfterTurn"] = false,
  ) {
    super();
  }

  async getThreadById({
    threadId,
    resourceId,
  }: {
    threadId: string;
    resourceId?: string;
  }): Promise<StorageThreadType | null> {
    const session = await this.memory.getSession(threadId);
    if (!session || !this.ownedSession(session, resourceId)) return null;
    return this.toThread(session);
  }

  async saveThread({ thread }: { thread: StorageThreadType }): Promise<StorageThreadType> {
    const existing = await this.getThreadById({
      threadId: thread.id,
      resourceId: thread.resourceId,
    });
    if (existing) return this.updateThread(thread);
    const session = await this.ensureSession(thread.id, thread.resourceId, {
      ...this.encodeMetadata(thread.metadata),
      ...(thread.title ? { [TITLE_METADATA_KEY]: thread.title } : {}),
    });
    return this.toThread(session);
  }

  async updateThread({
    id,
    title,
    metadata,
  }: {
    id: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<StorageThreadType> {
    const current = await this.memory.getSession(id);
    if (!current || !this.ownedSession(current)) throw new Error(`Thread ${id} not found`);
    const labels = {
      ...(current.metadata ?? {}),
      ...(title !== undefined ? { [TITLE_METADATA_KEY]: title } : {}),
      ...(metadata !== undefined ? this.encodeMetadata(metadata) : {}),
      [AGENT_METADATA_KEY]: this.agentId,
    };
    return this.toThread(
      await this.memory.updateSession({
        sessionId: id,
        actorId: current.actor_id,
        metadata: labels,
      }),
    );
  }

  async deleteThread({ threadId }: { threadId: string }): Promise<void> {
    const current = await this.memory.getSession(threadId);
    if (current && this.ownedSession(current)) await this.memory.deleteSession(threadId);
  }

  async listMessages(args: StorageListMessagesInput): Promise<StorageListMessagesOutput> {
    const threadIds = Array.isArray(args.threadId) ? args.threadId : [args.threadId];
    const messages = (
      await Promise.all(
        threadIds.map(async (threadId) => {
          const session = await this.memory.getSession(threadId);
          if (!session || !this.ownedSession(session, args.resourceId)) return [];
          return this.messagesForSession(session.session_id);
        }),
      )
    ).flat();
    return this.pageMessages(this.filterMessages(messages, args), args);
  }

  async listMessagesByResourceId(
    args: StorageListMessagesByResourceIdInput,
  ): Promise<StorageListMessagesOutput> {
    const sessions = (await this.memory.listSessions({ actorId: args.resourceId })).filter(
      (session) => this.ownedSession(session, args.resourceId),
    );
    const messages = (
      await Promise.all(sessions.map((session) => this.messagesForSession(session.session_id)))
    ).flat();
    return this.pageMessages(this.filterMessages(messages, args), args);
  }

  async listMessagesById({ messageIds }: { messageIds: string[] }): Promise<{
    messages: MastraDBMessage[];
  }> {
    const wanted = new Set(messageIds);
    const sessions = (await this.memory.listSessions()).filter((session) =>
      this.ownedSession(session),
    );
    const messages = (
      await Promise.all(sessions.map((session) => this.messagesForSession(session.session_id)))
    )
      .flat()
      .filter((message) => wanted.has(message.id));
    return { messages };
  }

  async saveMessages({ messages }: { messages: MastraDBMessage[] }): Promise<{
    messages: MastraDBMessage[];
  }> {
    const groups = groupMessages(messages);
    await Promise.all(
      [...groups.entries()].map(async ([threadId, grouped]) => {
        const resourceId = grouped.find((message) => message.resourceId)?.resourceId;
        if (!resourceId) throw new Error(`Messages for thread ${threadId} require resourceId`);
        await this.ensureSession(threadId, resourceId);
        await this.withSessionWrite(threadId, async () => {
          const existing = new Map(
            (await this.messagesForSession(threadId)).map((message) => [message.id, message]),
          );
          const changed = grouped.filter(
            (message) => !object.deepEqual(existing.get(message.id), message),
          );
          if (changed.length === 0) return;
          await this.memory.appendSessionItems(
            threadId,
            changed.map((message) => storedMessage(message)),
          );
          if (
            this.memory.memoryStore &&
            this.extractAfterTurn !== false &&
            changed.some((message) => message.role === "assistant")
          ) {
            await this.memory.extractSession({
              sessionId: threadId,
              ...(typeof this.extractAfterTurn === "object" && this.extractAfterTurn.instructions
                ? { instructions: this.extractAfterTurn.instructions }
                : {}),
            });
          }
        });
      }),
    );
    return { messages };
  }

  async updateMessages({
    messages,
  }: {
    messages: (Partial<Omit<MastraDBMessage, "createdAt">> & {
      id: string;
      content?: { metadata?: Record<string, unknown>; content?: string };
    })[];
  }): Promise<MastraDBMessage[]> {
    const current = await this.listMessagesById({
      messageIds: messages.map((message) => message.id),
    });
    const byId = new Map(current.messages.map((message) => [message.id, message]));
    const updated = messages.flatMap((patch) => {
      const existing = byId.get(patch.id);
      if (!existing) return [];
      return [
        {
          ...existing,
          ...patch,
          content: patch.content
            ? {
                ...existing.content,
                ...patch.content,
                metadata: {
                  ...existing.content.metadata,
                  ...patch.content.metadata,
                },
              }
            : existing.content,
        } satisfies MastraDBMessage,
      ];
    });
    await this.saveMessages({ messages: updated });
    return updated;
  }

  override async deleteMessages(messageIds: string[]): Promise<void> {
    const current = await this.listMessagesById({ messageIds });
    const byThread = groupMessages(current.messages);
    await Promise.all(
      [...byThread.entries()].map(([threadId, messages]) =>
        this.memory.appendSessionItems(
          threadId,
          messages.map((message) => ({
            type: DELETE_ITEM_TYPE,
            message_id: message.id,
          })),
        ),
      ),
    );
  }

  async listThreads(args: StorageListThreadsInput): Promise<StorageListThreadsOutput> {
    const sessions = (await this.memory.listSessions({ actorId: args.filter?.resourceId })).filter(
      (session) =>
        this.ownedSession(session, args.filter?.resourceId) &&
        metadataMatches(this.decodeMetadata(session.metadata), args.filter?.metadata),
    );
    const direction = args.orderBy?.direction ?? "DESC";
    const field = args.orderBy?.field ?? "updatedAt";
    const threads = sessions
      .map((session) => this.toThread(session))
      .sort((left, right) => {
        const a = field === "createdAt" ? left.createdAt : left.updatedAt;
        const b = field === "createdAt" ? right.createdAt : right.updatedAt;
        return (a.getTime() - b.getTime()) * (direction === "ASC" ? 1 : -1);
      });
    const page = args.page ?? 0;
    const perPage = args.perPage ?? 100;
    const start = perPage === false ? 0 : page * perPage;
    const selected = perPage === false ? threads : threads.slice(start, start + perPage);
    return {
      threads: selected,
      total: threads.length,
      page,
      perPage,
      hasMore: perPage === false ? false : start + selected.length < threads.length,
    };
  }

  override async copyThread(args: StorageCloneThreadInput): Promise<StorageCopyThreadOutput> {
    const source = await this.getThreadById({ threadId: args.sourceThreadId });
    if (!source) throw new Error(`Thread ${args.sourceThreadId} not found`);
    const destinationId = args.newThreadId ?? hash.id();
    const resourceId = args.resourceId ?? source.resourceId;
    const sourceMessages = (
      await this.listMessages({
        threadId: source.id,
        resourceId: source.resourceId,
        perPage: false,
      })
    ).messages;
    const filtered = filterCloneMessages(sourceMessages, args.options);
    const selected =
      args.options?.messageLimit !== undefined
        ? filtered.slice(Math.max(0, filtered.length - args.options.messageLimit))
        : filtered;
    const messageIdMap: Record<string, string> = {};
    const cloned = selected.map((message) => {
      const id = hash.id();
      messageIdMap[message.id] = id;
      return { ...message, id, threadId: destinationId, resourceId };
    });
    const thread = await this.saveThread({
      thread: {
        id: destinationId,
        resourceId,
        title: args.title ?? source.title,
        metadata: {
          ...source.metadata,
          ...args.metadata,
          sourceThreadId: source.id,
          clonedAt: new Date().toISOString(),
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    if (cloned.length > 0) await this.saveMessages({ messages: cloned });
    return { thread, messageIdMap };
  }

  async dangerouslyClearAll(): Promise<void> {
    const sessions = (await this.memory.listSessions()).filter((session) =>
      this.ownedSession(session),
    );
    await Promise.all(sessions.map((session) => this.memory.deleteSession(session.session_id)));
  }

  private async ensureSession(
    sessionId: string,
    actorId: string,
    metadata: Record<string, string> = {},
  ): Promise<AgentSession> {
    const ready = await this.memory.getSession(sessionId);
    if (ready) {
      if (!this.ownedSession(ready, actorId)) {
        throw new Error(`Session ${sessionId} belongs to another actor or agent`);
      }
      return ready;
    }
    const pending = this.creating.get(sessionId);
    if (pending) return pending;
    const creation = (async () => {
      const rechecked = await this.memory.getSession(sessionId);
      if (rechecked) {
        if (!this.ownedSession(rechecked, actorId)) {
          throw new Error(`Session ${sessionId} belongs to another actor or agent`);
        }
        return rechecked;
      }
      return this.memory.createSession({
        sessionId,
        actorId,
        metadata: { ...metadata, [AGENT_METADATA_KEY]: this.agentId },
      });
    })().finally(() => this.creating.delete(sessionId));
    this.creating.set(sessionId, creation);
    return creation;
  }

  private async withSessionWrite(sessionId: string, write: () => Promise<void>): Promise<void> {
    const previous = this.writing.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(write)
      .finally(() => {
        if (this.writing.get(sessionId) === current) this.writing.delete(sessionId);
      });
    this.writing.set(sessionId, current);
    await current;
  }

  private async messagesForSession(sessionId: string): Promise<MastraDBMessage[]> {
    const current = new Map<string, MastraDBMessage>();
    for (const item of await this.memory.listSessionItems(sessionId)) {
      const stored = StoredMessageSchema.safeParse(item.data);
      if (stored.success) {
        current.set(stored.data.mastra_message.id, deserializeMessage(stored.data.mastra_message));
        continue;
      }
      const deleted = DeletedMessageSchema.safeParse(item.data);
      if (deleted.success) current.delete(deleted.data.message_id);
    }
    return [...current.values()].sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
    );
  }

  private filterMessages(
    messages: MastraDBMessage[],
    args: StorageListMessagesInput | StorageListMessagesByResourceIdInput,
  ): MastraDBMessage[] {
    const range = args.filter?.dateRange;
    const metadata = args.filter?.metadata;
    const filtered = messages.filter((message) => {
      if (range?.start) {
        const delta = message.createdAt.getTime() - range.start.getTime();
        if (range.startExclusive ? delta <= 0 : delta < 0) return false;
      }
      if (range?.end) {
        const delta = message.createdAt.getTime() - range.end.getTime();
        if (range.endExclusive ? delta >= 0 : delta > 0) return false;
      }
      return metadataMatches(message.content.metadata, metadata);
    });
    const direction = args.orderBy?.direction ?? "ASC";
    return filtered.sort(
      (left, right) =>
        (left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)) *
        (direction === "ASC" ? 1 : -1),
    );
  }

  private pageMessages(
    messages: MastraDBMessage[],
    args: StorageListMessagesInput | StorageListMessagesByResourceIdInput,
  ): StorageListMessagesOutput {
    const page = args.page ?? 0;
    const perPage = args.perPage ?? 40;
    const start = perPage === false ? 0 : page * perPage;
    const selected = perPage === false ? messages : messages.slice(start, start + perPage);
    return {
      messages: selected,
      total: messages.length,
      page,
      perPage,
      hasMore: perPage === false ? false : start + selected.length < messages.length,
    };
  }

  private ownedSession(session: AgentSession, resourceId?: string): boolean {
    return (
      session.metadata?.[AGENT_METADATA_KEY] === this.agentId &&
      (resourceId === undefined || session.actor_id === resourceId)
    );
  }

  private toThread(session: AgentSession): StorageThreadType {
    return {
      id: session.session_id,
      resourceId: session.actor_id,
      ...(session.metadata?.[TITLE_METADATA_KEY]
        ? { title: session.metadata[TITLE_METADATA_KEY] }
        : {}),
      metadata: this.decodeMetadata(session.metadata),
      createdAt: new Date(session.create_time),
      updatedAt: new Date(session.last_activity_time ?? session.update_time ?? session.create_time),
    };
  }

  private encodeMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> {
    return metadata ? { [THREAD_METADATA_KEY]: JSON.stringify(metadata) } : {};
  }

  private decodeMetadata(metadata: Record<string, string> | undefined): Record<string, unknown> {
    const value = metadata?.[THREAD_METADATA_KEY];
    return value ? (json.parseRecord(value) ?? {}) : {};
  }
}

/** Runtime shared by Mastra agents and direct Genie mirroring. */
export class ManagedMemoryRuntime {
  readonly client: ManagedAgentMemoryClient;

  constructor(
    workspaceClient: WorkspaceClient,
    readonly options: ResolvedManagedMemoryOptions,
  ) {
    this.client = new ManagedAgentMemoryClient(workspaceClient, options);
  }

  storage(agentId: string): MastraCompositeStore {
    return new MastraCompositeStore({
      id: `databricks-agent-sessions__${agentId}`,
      domains: {
        memory: new ManagedSessionMemoryStorage(
          this.client,
          agentId,
          this.options.extractAfterTurn ?? true,
        ),
      },
    });
  }

  inputProcessor(): InputProcessor | undefined {
    if (!this.options.memoryStore || this.options.recall === false) return undefined;
    const recall = this.options.recall ?? {};
    return {
      id: "databricks_managed_memory",
      name: "Databricks managed memory",
      description: "Recall actor-scoped Databricks managed memory for the current turn.",
      processInput: async ({ messages, systemMessages, requestContext, abortSignal }) => {
        const actorId = requestContext?.get(MASTRA_RESOURCE_ID_KEY);
        const query = latestUserText(messages);
        if (typeof actorId !== "string" || !query) return { messages, systemMessages };
        try {
          const entries = await this.client.searchMemory({
            actorId,
            query,
            topK: recall.topK,
            pathPrefix: recall.pathPrefix,
            signal: abortSignal,
          });
          if (entries.length === 0) return { messages, systemMessages };
          return {
            messages,
            systemMessages: [
              ...systemMessages,
              {
                role: "system",
                content: [
                  MEMORY_CONTEXT_HEADING,
                  ...entries.map(
                    (entry) =>
                      `- ${entry.path}${entry.description ? ` (${entry.description})` : ""}: ${entry.content ?? ""}`,
                  ),
                ].join("\n"),
              },
            ],
          };
        } catch (error) {
          logger.warn("recall:error", { error: errorUtils.toError(error) });
          return { messages, systemMessages };
        }
      },
    };
  }

  async recordGenieTurn(input: {
    actorId: string;
    alias: string;
    conversationId: string;
    question: string;
    answer: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const storage = new ManagedSessionMemoryStorage(this.client, `genie:${input.alias}`);
    await storage.saveThread({
      thread: {
        id: input.conversationId,
        resourceId: input.actorId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await this.client.appendSessionItems(
      input.conversationId,
      [
        { type: "message", role: "user", content: input.question },
        { type: "message", role: "assistant", content: input.answer },
      ],
      input.signal,
    );
    if (this.options.memoryStore && this.options.extractAfterTurn !== false) {
      await this.client.extractSession({
        sessionId: input.conversationId,
        ...(typeof this.options.extractAfterTurn === "object" &&
        this.options.extractAfterTurn.instructions
          ? { instructions: this.options.extractAfterTurn.instructions }
          : {}),
        signal: input.signal,
      });
    }
  }
}

function resourceId(value: string, prefix: string): string {
  const trimmed = value.trim().replace(new RegExp(`^${prefix}/`), "");
  if (!trimmed) throw new Error(`${prefix} id is required`);
  return trimmed;
}

function agentStoreId(value: string): string {
  const slug = stringUtils.toSlugWithOptions({ maxLength: 55, truncateStrategy: "hash" }, value);
  const id = /^[a-z]/.test(slug) ? slug : `app-${slug}`;
  if (id.length < 3) return `${id}-store`.slice(0, 55);
  return id.slice(0, 55);
}

function filterString(value: string): string {
  return JSON.stringify(value);
}

function storedMessage(message: MastraDBMessage): Record<string, unknown> {
  return {
    type: MESSAGE_ITEM_TYPE,
    role: message.role,
    content: messageText(message),
    mastra_message: {
      id: message.id,
      role: message.role,
      createdAt: message.createdAt.toISOString(),
      ...(message.threadId ? { threadId: message.threadId } : {}),
      ...(message.resourceId ? { resourceId: message.resourceId } : {}),
      ...(message.type ? { messageType: message.type } : {}),
      content: message.content,
    },
  };
}

function deserializeMessage(
  value: z.infer<typeof StoredMessageSchema>["mastra_message"],
): MastraDBMessage {
  return {
    id: value.id,
    role: value.role,
    createdAt: new Date(value.createdAt),
    ...(value.threadId ? { threadId: value.threadId } : {}),
    ...(value.resourceId ? { resourceId: value.resourceId } : {}),
    ...(value.messageType ? { type: value.messageType } : {}),
    content: value.content as MastraDBMessage["content"],
  };
}

function messageText(message: MastraDBMessage): string {
  return message.content.parts
    .flatMap((part) =>
      object.isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n")
    .trim();
}

function latestUserText(messages: MastraDBMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = messageText(message);
    if (text) return text;
  }
  return undefined;
}

function groupMessages(messages: MastraDBMessage[]): Map<string, MastraDBMessage[]> {
  const groups = new Map<string, MastraDBMessage[]>();
  for (const message of messages) {
    if (!message.threadId) throw new Error(`Message ${message.id} requires threadId`);
    const current = groups.get(message.threadId);
    if (current) current.push(message);
    else groups.set(message.threadId, [message]);
  }
  return groups;
}

function metadataMatches(
  metadata: Record<string, unknown> | undefined,
  expected: Record<string, unknown> | undefined,
): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(([key, value]) => metadata?.[key] === value);
}

function filterCloneMessages(
  messages: MastraDBMessage[],
  options: StorageCloneThreadInput["options"],
): MastraDBMessage[] {
  const filter = options?.messageFilter;
  if (!filter) return messages;
  const ids = filter.messageIds ? new Set(filter.messageIds) : undefined;
  return messages.filter(
    (message) =>
      (!ids || ids.has(message.id)) &&
      (!filter.startDate || message.createdAt >= filter.startDate) &&
      (!filter.endDate || message.createdAt <= filter.endDate),
  );
}
