/**
 * Databricks Agent Memory REST client.
 *
 * @module
 */

import type { WorkspaceClient } from "@databricks/appkit";
import { databricks } from "@dbx-tools/appkit";
import { errorUtils } from "@dbx-tools/shared-core";
import { z } from "zod";

import type { ResolvedDatabricksMemoryOptions } from "../config.ts";

export const ManagedMemoryEntrySchema = z
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

/** One managed-memory search result with its optional backend score. */
export interface ManagedMemorySearchResult {
  readonly entry: ManagedMemoryEntry;
  readonly score?: number;
}

/** Thin REST client for actor-scoped Databricks Agent Memory operations. */
export class ManagedAgentMemoryClient {
  readonly memoryStore: string;

  constructor(
    private readonly client: WorkspaceClient,
    options: ResolvedDatabricksMemoryOptions,
  ) {
    this.memoryStore = options.memoryStore;
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
    limit: number;
    signal?: AbortSignal;
  }): Promise<ManagedMemorySearchResult[]> {
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
            page_size: input.limit,
          },
        },
        input.signal ? databricks.toContext(input.signal) : undefined,
      ),
    );
    if (response.results) {
      return response.results.map((result) => ({
        entry: result.managed_memory_entry,
        ...(result.score === undefined ? {} : { score: result.score }),
      }));
    }
    return (response.managed_memory_entries ?? []).map((entry) => ({ entry }));
  }

  async saveMemory(input: {
    actorId: string;
    path: string;
    content: string;
    description?: string;
    signal?: AbortSignal;
  }): Promise<ManagedMemoryEntry> {
    const existing = (await this.listMemoryEntries(input))[0];
    if (existing?.name) {
      return this.updateMemory(existing as ManagedMemoryEntry & { name: string }, input);
    }
    try {
      return await this.createMemory(input);
    } catch (error) {
      if (!errorUtils.errorContext(error).hasStatusCode(409)) throw error;
      const raced = (await this.listMemoryEntries(input))[0];
      if (!raced?.name) throw error;
      return this.updateMemory(raced as ManagedMemoryEntry & { name: string }, input);
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
          payload: {
            actor_id: input.actorId,
            path: input.path,
            content: input.content,
            ...(input.description ? { description: input.description } : {}),
            source_type: "MANAGED_MEMORY_ENTRY_SOURCE_TYPE_AGENT",
          },
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
    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/json",
    });
    await this.client.config.authenticate(headers);
    const response = await fetch(
      new URL(
        `/api/2.0/agents/${current.name
          .split("/")
          .map((part) => encodeURIComponent(part))
          .join("/")}?update_mask=content,description`,
        (await this.client.config.getHost()).toString(),
      ),
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          actor_id: input.actorId,
          path: input.path,
          content: input.content,
          ...(input.description ? { description: input.description } : {}),
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw Object.assign(
        new Error(`Databricks Agent Memory request failed (${response.status})`),
        { statusCode: response.status, response: body },
      );
    }
    return ManagedMemoryEntrySchema.parse(body);
  }
}
