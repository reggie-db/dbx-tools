/**
 * Databricks Agent Memory recall for Mastra.
 *
 * This is additive to Mastra's regular PostgresStore and PgVector memory. A
 * native Mastra input processor searches one actor partition on each user turn
 * and adds matching managed-memory entries only to that model request.
 *
 * @module
 */

import { getExecutionContext, type WorkspaceClient } from "@databricks/appkit";
import { databricks } from "@dbx-tools/appkit";
import { createCache, getOrSet } from "@dbx-tools/cache/cache";
import { projectUtils } from "@dbx-tools/core";
import { errorUtils, log, object, stringUtils } from "@dbx-tools/shared-core";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { InputProcessor } from "@mastra/core/processors";
import { MASTRA_RESOURCE_ID_KEY, type RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { databricksFetch, readResponseJson } from "./rest.ts";

const logger = log.logger("mastra/managed-memory");
const MEMORY_CONTEXT_HEADING = "Relevant long-term memory";
const ACCESS_CACHE_TTL_MS = 5 * 60_000;
const accessCache = createCache({
  maxEntries: 1_000,
  ttl: ACCESS_CACHE_TTL_MS,
  useClone: false,
});

/** Databricks managed-memory configuration for the Mastra plugin. */
export interface ManagedMemoryOptions {
  /**
   * Existing Agent Memory Store id or resource name. Defaults to the normalized
   * {@link projectUtils.name} value.
   */
  memoryStore?: string;
  /** Search settings applied once to each user turn. */
  recall?: false | { topK?: number; pathPrefix?: string };
}

/** Enable managed memory with the project default or configure it explicitly. */
export type ManagedMemoryConfig = true | ManagedMemoryOptions;

/** Fully resolved Agent Memory Store configuration. */
export type ResolvedManagedMemoryOptions = Omit<ManagedMemoryOptions, "memoryStore"> & {
  memoryStore: string;
};

/** Resolve an omitted store id from the normalized project name. */
export function resolveManagedMemoryOptions(
  options: ManagedMemoryConfig,
): ResolvedManagedMemoryOptions {
  const configured = options === true ? {} : options;
  return {
    ...configured,
    memoryStore: configured.memoryStore?.trim() || agentStoreId(projectUtils.name()),
  };
}

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

const ListMemoryResponseSchema = z
  .object({
    managed_memory_entries: z
      .array(ManagedMemoryEntrySchema)
      .optional()
      .describe("Managed memory entries in this page."),
    next_page_token: z.string().optional().describe("Next page token."),
  })
  .loose()
  .describe("Page of Databricks managed memory entries.");

/** Thin REST client for Databricks Agent Memory search. */
export class ManagedAgentMemoryClient {
  readonly memoryStore: string;

  constructor(
    private readonly client: WorkspaceClient,
    options: ResolvedManagedMemoryOptions,
  ) {
    this.memoryStore = resourceId(options.memoryStore, "memory-stores");
  }

  async available(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.client.apiClient.request(
        {
          path: `/api/2.0/agents/memory-stores/${encodeURIComponent(this.memoryStore)}`,
          method: "GET",
          headers: new Headers({ accept: "application/json" }),
          raw: false,
        },
        signal ? databricks.toContext(signal) : undefined,
      );
      return true;
    } catch (error) {
      if (errorUtils.errorContext(error).hasStatusCode(403, 404)) return false;
      throw error;
    }
  }

  async searchMemory(input: {
    actorId: string;
    query: string;
    topK?: number;
    pathPrefix?: string;
    sessionId?: string;
    signal?: AbortSignal;
  }): Promise<ManagedMemoryEntry[]> {
    const response = SearchMemoryResponseSchema.parse(
      await this.client.apiClient.request(
        {
          path: `/api/2.0/agents/memory-stores/${encodeURIComponent(this.memoryStore)}/entries:search`,
          method: "POST",
          headers: new Headers({
            accept: "application/json",
            "content-type": "application/json",
          }),
          raw: false,
          payload: {
            actor_id: input.actorId,
            query: input.query,
            page_size: input.topK ?? 10,
            ...(input.pathPrefix ? { path_prefix: input.pathPrefix } : {}),
            ...(input.sessionId ? { session_id: input.sessionId } : {}),
          },
        },
        input.signal ? databricks.toContext(input.signal) : undefined,
      ),
    );
    if (response.results) return response.results.map((result) => result.managed_memory_entry);
    return response.managed_memory_entries ?? [];
  }

  async saveMemory(input: {
    actorId: string;
    path: string;
    content: string;
    description?: string;
    signal?: AbortSignal;
  }): Promise<ManagedMemoryEntry> {
    const existing = (await this.listMemoryEntries(input))[0];
    if (existing?.name) return this.updateMemory({ ...existing, name: existing.name }, input);
    try {
      return await this.createMemory(input);
    } catch (error) {
      if (!errorUtils.errorContext(error).hasStatusCode(409)) throw error;
      const raced = (await this.listMemoryEntries(input))[0];
      if (!raced?.name) throw error;
      return this.updateMemory({ ...raced, name: raced.name }, input);
    }
  }

  private async createMemory(input: {
    actorId: string;
    path: string;
    content: string;
    description?: string;
    signal?: AbortSignal;
  }): Promise<ManagedMemoryEntry> {
    return ManagedMemoryEntrySchema.parse(
      await this.client.apiClient.request(
        {
          path: `/api/2.0/agents/memory-stores/${encodeURIComponent(this.memoryStore)}/entries`,
          method: "POST",
          headers: new Headers({
            accept: "application/json",
            "content-type": "application/json",
          }),
          raw: false,
          payload: memoryPayload(input),
        },
        input.signal ? databricks.toContext(input.signal) : undefined,
      ),
    );
  }

  private async listMemoryEntries(input: {
    actorId: string;
    path: string;
    signal?: AbortSignal;
  }): Promise<ManagedMemoryEntry[]> {
    const response = ListMemoryResponseSchema.parse(
      await this.client.apiClient.request(
        {
          path: `/api/2.0/agents/memory-stores/${encodeURIComponent(this.memoryStore)}/entries`,
          method: "GET",
          headers: new Headers({ accept: "application/json" }),
          query: {
            actor_id: input.actorId,
            path: input.path,
            page_size: 100,
          },
          raw: false,
        },
        input.signal ? databricks.toContext(input.signal) : undefined,
      ),
    );
    return (response.managed_memory_entries ?? []).filter((entry) => entry.path === input.path);
  }

  private async updateMemory(
    current: ManagedMemoryEntry & { name: string },
    input: {
      actorId: string;
      path: string;
      content: string;
      description?: string;
      signal?: AbortSignal;
    },
  ): Promise<ManagedMemoryEntry> {
    const response = await databricksFetch(
      this.client,
      `/api/2.0/agents/${current.name
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")}?update_mask=content,description`,
      {
        method: "PATCH",
        body: memoryPayload(input),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    const body = await readResponseJson(response);
    if (!response.ok) {
      throw Object.assign(
        new Error(`Databricks Agent Memory request failed (${response.status})`),
        { statusCode: response.status, response: body },
      );
    }
    return ManagedMemoryEntrySchema.parse(body);
  }
}

/** Runtime that contributes managed-memory recall to each Mastra agent. */
export class ManagedMemoryRuntime {
  constructor(
    private readonly workspaceClient: WorkspaceClient,
    readonly options: ResolvedManagedMemoryOptions,
  ) {}

  inputProcessor(): InputProcessor | undefined {
    if (this.options.recall === false) return undefined;
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
          const request = this.requestClient(actorId);
          if (!(await this.available(request.cacheKey, request.client, abortSignal))) {
            return { messages, systemMessages };
          }
          const entries = await request.client.searchMemory({
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

  async tools(requestContext?: RequestContext) {
    const actorId = requestContext?.get(MASTRA_RESOURCE_ID_KEY);
    if (typeof actorId !== "string") return {};
    const request = this.requestClient(actorId);
    if (!(await this.available(request.cacheKey, request.client))) return {};
    return {
      remember: createTool({
        id: "remember",
        description:
          "Save a durable user preference, fact, decision, or instruction to Databricks Agent Memory. Use when the user explicitly asks you to remember something for future conversations.",
        inputSchema: z.object({
          path: z
            .string()
            .startsWith("/")
            .describe("Stable absolute path, such as /preferences/food.md."),
          content: z.string().min(1).describe("Durable memory content."),
          description: z.string().optional().describe("Short retrieval-oriented description."),
        }),
        outputSchema: ManagedMemoryEntrySchema,
        execute: async (input, context) =>
          request.client.saveMemory({
            actorId,
            path: input.path,
            content: input.content,
            ...(input.description ? { description: input.description } : {}),
            ...((context as { abortSignal?: AbortSignal } | undefined)?.abortSignal
              ? { signal: (context as { abortSignal: AbortSignal }).abortSignal }
              : {}),
          }),
      }),
    };
  }

  private requestClient(actorId: string): {
    client: ManagedAgentMemoryClient;
    cacheKey: string;
  } {
    let workspaceClient = this.workspaceClient;
    let credentialId = actorId;
    try {
      const execution = getExecutionContext();
      workspaceClient = execution.client;
      credentialId = "userId" in execution ? execution.userId : execution.serviceUserId;
    } catch {
      // Startup and tests have no active AppKit request context.
    }
    return {
      client: new ManagedAgentMemoryClient(workspaceClient, this.options),
      cacheKey: `${this.options.memoryStore}:${credentialId}:${actorId}`,
    };
  }

  private async available(
    cacheKey: string,
    client: ManagedAgentMemoryClient,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return (await getOrSet(accessCache, cacheKey, () => client.available(signal))) ?? false;
  }
}

function resourceId(value: string, prefix: string): string {
  const trimmed = value.trim().replace(new RegExp(`^${prefix}/`), "");
  if (!trimmed) throw new Error(`${prefix} id is required`);
  return trimmed;
}

function memoryPayload(input: {
  actorId: string;
  path: string;
  content: string;
  description?: string;
}): Record<string, unknown> {
  return {
    actor_id: input.actorId,
    path: input.path,
    content: input.content,
    ...(input.description ? { description: input.description } : {}),
    source_type: "MANAGED_MEMORY_ENTRY_SOURCE_TYPE_AGENT",
  };
}

function agentStoreId(value: string): string {
  const slug = stringUtils.toSlugWithOptions({ maxLength: 56, truncateStrategy: "hash" }, value);
  const id = /^[a-z]/.test(slug) ? slug : `app-${slug}`;
  if (id.length < 3) return `${id}-store`.slice(0, 56);
  return id.slice(0, 56);
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
