/**
 * Backend-neutral memory tool and turn contracts.
 *
 * @module
 */

import { z } from "zod";

export const RememberMemoryInputSchema = z
  .object({
    path: z
      .string()
      .trim()
      .startsWith("/")
      .describe("Stable absolute memory path, such as /preferences/response.md."),
    content: z.string().trim().min(1).describe("Durable memory content."),
    description: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Short retrieval-oriented description."),
  })
  .strict()
  .describe("Durable memory to save for the current actor.");

export type RememberMemoryInput = z.infer<typeof RememberMemoryInputSchema>;

export const RecallMemoryInputSchema = z
  .object({
    query: z.string().trim().min(1).describe("Question or phrase used to retrieve memory."),
    limit: z.coerce
      .number<number>()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe("Maximum number of matching memories to return."),
  })
  .strict()
  .describe("Actor-scoped memory search.");

export type RecallMemoryInput = z.input<typeof RecallMemoryInputSchema>;

export const MemoryBackendSchema = z
  .enum(["databricks", "graphiti"])
  .describe("Memory backend that completed the operation.");

export type MemoryBackend = z.infer<typeof MemoryBackendSchema>;

export const MemoryRecordSchema = z
  .object({
    path: z.string().optional().describe("Stable memory path when the backend supports paths."),
    content: z.string().describe("Retrieved or saved memory content."),
    description: z.string().optional().describe("Retrieval-oriented memory description."),
    score: z.number().optional().describe("Backend relevance score when available."),
  })
  .strict()
  .describe("Backend-neutral durable memory record.");

export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const RememberMemoryResultSchema = z
  .object({
    backend: MemoryBackendSchema,
    memory: MemoryRecordSchema,
  })
  .strict()
  .describe("Result of saving one durable memory.");

export type RememberMemoryResult = z.infer<typeof RememberMemoryResultSchema>;

export const RecallMemoryResultSchema = z
  .object({
    backend: MemoryBackendSchema,
    memories: z.array(MemoryRecordSchema).describe("Matching actor-scoped memories."),
  })
  .strict()
  .describe("Result of one durable memory search.");

export type RecallMemoryResult = z.infer<typeof RecallMemoryResultSchema>;

/** Completed Mastra turn offered to the optional external saver. */
export interface MemoryTurn {
  readonly agentId: string;
  readonly actorId: string;
  readonly threadId: string;
  readonly user: string;
  readonly assistant: string;
}

/** Lazy Graphiti backend used only after managed memory is unavailable. */
export interface GraphitiMemoryBackend {
  readonly running: boolean;
  remember(
    actorId: string,
    input: RememberMemoryInput,
    signal?: AbortSignal,
  ): Promise<RememberMemoryResult>;
  recall(
    actorId: string,
    input: z.output<typeof RecallMemoryInputSchema>,
    signal?: AbortSignal,
  ): Promise<RecallMemoryResult>;
  saveTurn(turn: MemoryTurn, signal?: AbortSignal): Promise<void>;
  shutdown(): Promise<void>;
}
