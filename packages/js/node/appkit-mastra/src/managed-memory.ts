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
import { projectUtils } from "@dbx-tools/core";
import { errorUtils, log, object, stringUtils } from "@dbx-tools/shared-core";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { InputProcessor } from "@mastra/core/processors";
import { MASTRA_RESOURCE_ID_KEY, type RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const logger = log.logger("mastra/managed-memory");
const MEMORY_CONTEXT_HEADING = "Relevant long-term memory";

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
          payload: {
            actor_id: input.actorId,
            path: input.path,
            content: input.content,
            ...(input.description ? { description: input.description } : {}),
            source_type: "MANAGED_MEMORY_ENTRY_SOURCE_TYPE_AGENT",
            write_mode: "overwrite",
          },
        },
        input.signal ? databricks.toContext(input.signal) : undefined,
      ),
    );
  }
}

/** Runtime that contributes managed-memory recall to each Mastra agent. */
export class ManagedMemoryRuntime {
  private readonly access = new Map<string, { available: boolean; expiresAt: number }>();

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
          const client = this.requestClient();
          if (!(await this.available(actorId, client, abortSignal))) {
            return { messages, systemMessages };
          }
          const entries = await client.searchMemory({
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
    const client = this.requestClient();
    if (!(await this.available(actorId, client))) return {};
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
          client.saveMemory({
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

  private requestClient(): ManagedAgentMemoryClient {
    let workspaceClient = this.workspaceClient;
    try {
      workspaceClient = getExecutionContext().client;
    } catch {
      // Startup and tests have no active AppKit request context.
    }
    return new ManagedAgentMemoryClient(workspaceClient, this.options);
  }

  private async available(
    actorId: string,
    client: ManagedAgentMemoryClient,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const cached = this.access.get(actorId);
    if (cached && cached.expiresAt > Date.now()) return cached.available;
    const available = await client.available(signal);
    this.access.set(actorId, { available, expiresAt: Date.now() + 5 * 60_000 });
    return available;
  }
}

function resourceId(value: string, prefix: string): string {
  const trimmed = value.trim().replace(new RegExp(`^${prefix}/`), "");
  if (!trimmed) throw new Error(`${prefix} id is required`);
  return trimmed;
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
