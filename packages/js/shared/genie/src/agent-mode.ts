/**
 * Browser-safe Genie Agent Mode SSE contracts.
 *
 * Schemas validate the stable Responses-style event envelope while preserving
 * additive fields and output-item variants introduced by the beta API.
 *
 * @module
 */

import { z } from "zod";
import { json, object } from "@dbx-tools/shared-core";

import {
  GenieMessageSchema,
  type GenieAttachment,
  type GenieMessage,
  type GenieThought,
} from "./genie-model.ts";

/** Agent Mode output content item with forward-compatible fields. */
export const GenieAgentContentSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    metadata: z.unknown().optional(),
  })
  .loose();

/** Agent Mode response output item with known projection fields. */
export const GenieAgentOutputItemSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    call_id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
    output: z.string().optional(),
    status: z.string().optional(),
    content: z.array(GenieAgentContentSchema).optional(),
  })
  .loose();

/** Genie Agent Mode response carried by lifecycle events. */
export const GenieAgentResponseSchema = z
  .object({
    object: z.string().optional(),
    id: z.string(),
    model: z.string().optional(),
    status: z.string(),
    output: z.array(GenieAgentOutputItemSchema).optional(),
    conversation_id: z.string().optional(),
    created_at: z.number().optional(),
    error: z.unknown().optional(),
  })
  .loose();

/** One SSE event from the Genie Agent Mode response stream. */
export const GenieAgentModeEventSchema = z
  .object({
    type: z.string(),
    sequence_number: z.number().optional(),
    output_index: z.number().optional(),
    response: GenieAgentResponseSchema.optional(),
    item: GenieAgentOutputItemSchema.optional(),
  })
  .loose();

/** Validated Agent Mode response output item. */
export type GenieAgentOutputItem = z.infer<typeof GenieAgentOutputItemSchema>;
/** Validated Agent Mode response. */
export type GenieAgentResponse = z.infer<typeof GenieAgentResponseSchema>;
/** Validated Agent Mode SSE event. */
export type GenieAgentModeEvent = z.infer<typeof GenieAgentModeEventSchema>;

/** Stateful pure reducer from Agent Mode SSE events to Genie message snapshots. */
export class GenieAgentModeProjection {
  private readonly items = new Map<string, GenieAgentOutputItem>();
  private response: GenieAgentResponse | undefined;

  constructor(
    private readonly spaceId: string,
    private readonly content: string,
  ) {}

  /** Apply one validated SSE event and return its projected snapshot. */
  apply(event: GenieAgentModeEvent): GenieMessage | undefined {
    if (event.response) {
      this.response = event.response;
      if (event.response.output) {
        this.items.clear();
        event.response.output.forEach((item, index) => {
          this.items.set(agentItemKey(item, index), item);
        });
      }
    }
    if (event.item) {
      this.items.set(agentItemKey(event.item, event.output_index), event.item);
    }
    if ((!event.response && !event.item) || !this.response) return undefined;
    return projectAgentModeMessage(this.spaceId, this.content, this.response, [
      ...this.items.values(),
    ]);
  }

  /** Current response id, once `response.created` has arrived. */
  get responseId(): string | undefined {
    return this.response?.id;
  }

  /** Current conversation id, once assigned by Genie. */
  get conversationId(): string | undefined {
    return this.response?.conversation_id;
  }

  /** Whether the latest response status is terminal. */
  get terminal(): boolean {
    return this.response ? isTerminalStatus(this.response.status) : false;
  }
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function agentItemKey(item: GenieAgentOutputItem, index: unknown): string {
  if (typeof item.id === "string") return item.id;
  if (typeof item.call_id === "string") return item.call_id;
  return String(typeof index === "number" ? index : (item.type ?? "item"));
}

/** Project one Agent Mode response snapshot onto the shared Genie message shape. */
export function projectAgentModeMessage(
  spaceId: string,
  content: string,
  response: GenieAgentResponse,
  items: GenieAgentOutputItem[],
): GenieMessage {
  const errorValue = object.isRecord(response.error) ? response.error : undefined;
  const errorMessage =
    typeof errorValue?.message === "string"
      ? errorValue.message
      : typeof response.error === "string"
        ? response.error
        : undefined;
  return GenieMessageSchema.parse({
    id: response.id,
    message_id: response.id,
    space_id: spaceId,
    conversation_id: response.conversation_id ?? "",
    content,
    status: agentModeStatus(response.status, items),
    attachments: items.flatMap(itemAttachments),
    ...(response.created_at !== undefined ? { created_timestamp: response.created_at } : {}),
    ...(errorMessage ? { error: { error: errorMessage } } : {}),
  });
}

function agentModeStatus(value: string, items: GenieAgentOutputItem[]): GenieMessage["status"] {
  if (value === "completed") return "COMPLETED";
  if (value === "failed") return "FAILED";
  if (value === "cancelled") return "CANCELLED";
  if (items.some((item) => item.type === "function_call")) return "EXECUTING_QUERY";
  return "ASKING_AI";
}

function itemAttachments(item: GenieAgentOutputItem): GenieAttachment[] {
  const id = item.id ?? item.call_id;
  if (item.type === "reasoning") {
    const thoughts = contentText(item.content, "reasoning_text").map(
      (thoughtContent): GenieThought => ({
        thought_type: "THOUGHT_TYPE_STEPS",
        content: thoughtContent,
      }),
    );
    return thoughts.length === 0
      ? []
      : [{ attachment_id: id, attachment_type: "query", query: { id, thoughts } }];
  }
  if (item.type === "function_call") {
    const argumentsValue = json.parseRecord(item.arguments);
    const query =
      typeof argumentsValue?.sql === "string"
        ? argumentsValue.sql
        : typeof argumentsValue?.query === "string"
          ? argumentsValue.query
          : undefined;
    const title = typeof argumentsValue?.title === "string" ? argumentsValue.title : item.name;
    return query
      ? [
          {
            attachment_id: id,
            attachment_type: "query",
            query: {
              id,
              query,
              ...(title ? { title } : {}),
            },
          },
        ]
      : [];
  }
  if (item.type === "function_call_output" && item.output !== undefined) {
    return [textAttachment(id, item.output)];
  }
  if (item.type === "message") {
    return (item.content ?? []).flatMap((part) =>
      part.type === "output_text" && part.text
        ? [textAttachment(id, part.text, part.metadata)]
        : [],
    );
  }
  return [];
}

function contentText(
  value: z.infer<typeof GenieAgentContentSchema>[] | undefined,
  type: string,
): string[] {
  if (!value) return [];
  return value.flatMap((part) => (part.type === type && part.text ? [part.text] : []));
}

function textAttachment(
  id: string | undefined,
  content: string,
  metadata?: unknown,
): GenieAttachment {
  return {
    attachment_id: id,
    attachment_type: "text",
    text: {
      id,
      content,
      purpose: "TEXT_ATTACHMENT_PURPOSE_ANSWER",
      ...(metadata !== undefined ? { metadata } : {}),
    },
  };
}
