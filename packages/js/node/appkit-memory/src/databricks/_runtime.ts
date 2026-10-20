/**
 * Request-scoped Databricks managed-memory routing.
 *
 * @module
 */

import { getExecutionContext, type WorkspaceClient } from "@databricks/appkit";
import { createCache, getOrSet } from "@dbx-tools/cache";

import {
  RecallMemoryInputSchema,
  type RecallMemoryInput,
  type RecallMemoryResult,
  type RememberMemoryInput,
  type RememberMemoryResult,
} from "../_contracts.ts";
import type { ResolvedDatabricksMemoryOptions } from "../config.ts";
import { ManagedAgentMemoryClient } from "./client.ts";

const ACCESS_CACHE_TTL_MS = 5 * 60_000;
const accessCache = createCache({
  maxEntries: 1_000,
  ttl: ACCESS_CACHE_TTL_MS,
  useClone: false,
});

/** Databricks backend that selects the active request credential for each call. */
export class DatabricksMemoryRuntime {
  constructor(
    private readonly workspaceClient: WorkspaceClient,
    readonly options: ResolvedDatabricksMemoryOptions,
  ) {}

  async available(actorId: string, signal?: AbortSignal): Promise<boolean> {
    const request = this.requestClient(actorId);
    return (
      (await getOrSet(accessCache, request.cacheKey, () => request.client.available(signal))) ??
      false
    );
  }

  async remember(
    actorId: string,
    input: RememberMemoryInput,
    signal?: AbortSignal,
  ): Promise<RememberMemoryResult> {
    const entry = await this.requestClient(actorId).client.saveMemory({
      actorId,
      ...input,
      ...(signal ? { signal } : {}),
    });
    return {
      backend: "databricks",
      memory: {
        path: entry.path,
        content: entry.content ?? input.content,
        ...(entry.description ? { description: entry.description } : {}),
      },
    };
  }

  async recall(
    actorId: string,
    input: RecallMemoryInput,
    signal?: AbortSignal,
  ): Promise<RecallMemoryResult> {
    const parsed = RecallMemoryInputSchema.parse(input);
    const results = await this.requestClient(actorId).client.searchMemory({
      actorId,
      query: parsed.query,
      limit: parsed.limit,
      ...(signal ? { signal } : {}),
    });
    return {
      backend: "databricks",
      memories: results.map(({ entry, score }) => ({
        path: entry.path,
        content: entry.content ?? "",
        ...(entry.description ? { description: entry.description } : {}),
        ...(score === undefined ? {} : { score }),
      })),
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
}
