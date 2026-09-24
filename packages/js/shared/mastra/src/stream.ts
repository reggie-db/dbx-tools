/**
 * Runtime-validated Mastra agent stream chunks shared by browser clients.
 *
 * Known event names are strict about the payload fields the UI consumes, so a
 * malformed upstream chunk fails before it reaches a state reducer. Unknown
 * event names remain forward-compatible through an explicit `unknown` variant
 * that preserves the original event name and payload.
 *
 * @module
 */

import { z } from "zod";

const runFields = {
  runId: z.string().min(1).optional(),
};

const EmptyStreamChunkSchema = <Type extends string>(type: Type) =>
  z
    .object({
      type: z.literal(type),
      payload: z.unknown().optional(),
      ...runFields,
    })
    .passthrough();

const TextDeltaStreamChunkSchema = z
  .object({
    type: z.literal("text-delta"),
    payload: z.object({ text: z.string() }).passthrough(),
    ...runFields,
  })
  .passthrough();

const ReasoningDeltaStreamChunkSchema = z
  .object({
    type: z.literal("reasoning-delta"),
    payload: z.object({ text: z.string() }).passthrough(),
    ...runFields,
  })
  .passthrough();

const ToolCallStreamChunkSchema = z
  .object({
    type: z.literal("tool-call"),
    payload: z
      .object({
        toolCallId: z.string().min(1),
        toolName: z.string().min(1),
        args: z.unknown().optional(),
      })
      .passthrough(),
    ...runFields,
  })
  .passthrough();

const ToolCallApprovalStreamChunkSchema = z
  .object({
    type: z.literal("tool-call-approval"),
    payload: z
      .object({
        toolCallId: z.string().min(1),
        toolName: z.string().min(1),
        args: z.unknown().optional(),
        runId: z.string().min(1).optional(),
      })
      .passthrough(),
    ...runFields,
  })
  .passthrough();

const ToolTerminalStreamChunkSchema = <Type extends "tool-result" | "tool-error">(type: Type) =>
  z
    .object({
      type: z.literal(type),
      payload: z.object({ toolCallId: z.string().min(1) }).passthrough(),
      ...runFields,
    })
    .passthrough();

const ToolOutputStreamChunkSchema = z
  .object({
    type: z.literal("tool-output"),
    payload: z
      .object({
        toolCallId: z.string().min(1),
        output: z.unknown(),
      })
      .passthrough(),
    ...runFields,
  })
  .passthrough();

const StreamErrorDetailSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

const ErrorStreamChunkSchema = z
  .object({
    type: z.literal("error"),
    payload: z
      .object({
        error: StreamErrorDetailSchema.optional(),
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
    ...runFields,
  })
  .passthrough();

/** Known Mastra events consumed by the chat UI. */
export const KnownMastraStreamChunkSchema = z.discriminatedUnion("type", [
  EmptyStreamChunkSchema("text-start"),
  TextDeltaStreamChunkSchema,
  EmptyStreamChunkSchema("text-end"),
  ReasoningDeltaStreamChunkSchema,
  ToolCallStreamChunkSchema,
  ToolCallApprovalStreamChunkSchema,
  ToolTerminalStreamChunkSchema("tool-result"),
  ToolTerminalStreamChunkSchema("tool-error"),
  ToolOutputStreamChunkSchema,
  ErrorStreamChunkSchema,
]);

/** A validated stream event whose name this client version does not consume. */
export type UnknownMastraStreamChunk = {
  type: "unknown";
  eventType: string;
  payload?: unknown;
  runId?: string;
};

const knownEventTypes: ReadonlySet<string> = new Set(
  KnownMastraStreamChunkSchema.options.map((option) => option.shape.type.value),
);

const UnknownMastraStreamChunkSchema = z
  .object({
    type: z.string().min(1),
    payload: z.unknown().optional(),
    ...runFields,
  })
  .passthrough()
  .refine((chunk) => !knownEventTypes.has(chunk.type), {
    path: ["type"],
    message: "known stream event has an invalid payload",
  })
  .transform((chunk): UnknownMastraStreamChunk => ({
    type: "unknown",
    eventType: chunk.type,
    ...(chunk.payload !== undefined ? { payload: chunk.payload } : {}),
    ...(chunk.runId !== undefined ? { runId: chunk.runId } : {}),
  }));

/**
 * Complete validated stream union. Known events retain their discriminant;
 * future event names normalize to the explicit `unknown` variant.
 */
export const MastraStreamChunkSchema = z.union([
  KnownMastraStreamChunkSchema,
  UnknownMastraStreamChunkSchema,
]);

/** One runtime-validated event from a Mastra agent SSE stream. */
export type MastraStreamChunk = z.output<typeof MastraStreamChunkSchema>;
