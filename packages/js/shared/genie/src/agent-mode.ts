/**
 * Browser-safe Genie Agent Mode SSE contracts.
 *
 * Schemas validate the stable Responses-style event envelope while preserving
 * additive fields and output-item variants introduced by the beta API.
 *
 * @module
 */

import { parseRecord, isRecord } from "@dbx-tools/shared-core";
import { z } from "zod";

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
    role: z.string().optional(),
    content: z.array(GenieAgentContentSchema).optional(),
    metadata: z.unknown().optional(),
    created_at: z.number().optional(),
  })
  .loose();

/** One page of an Agent Mode conversation's item history. */
export const GenieAgentConversationItemsSchema = z
  .object({
    data: z.array(GenieAgentOutputItemSchema).describe("Conversation items, oldest first."),
    has_more: z.boolean().optional().describe("Whether another page follows `last_id`."),
    last_id: z.string().optional().describe("Item id that the next page starts after."),
    status: z.string().optional().describe("Current status of the conversation's latest response."),
  })
  .loose()
  .describe("Page of Agent Mode conversation items.");

/** Validated Agent Mode conversation item page. */
export type GenieAgentConversationItems = z.infer<typeof GenieAgentConversationItemsSchema>;

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
  const errorValue = isRecord(response.error) ? response.error : undefined;
  const errorMessage =
    typeof errorValue?.message === "string"
      ? errorValue.message
      : typeof response.error === "string"
        ? response.error
        : undefined;
  const messageId = items.map(itemMessageId).find((id) => id !== undefined) ?? response.id;
  return GenieMessageSchema.parse({
    id: messageId,
    message_id: messageId,
    space_id: spaceId,
    conversation_id: response.conversation_id ?? "",
    content,
    status: agentModeStatus(response.status, items),
    attachments: withStatementIds(items.flatMap(itemAttachments), items),
    ...(response.created_at !== undefined ? { created_timestamp: response.created_at } : {}),
    ...(errorMessage ? { error: { error: errorMessage } } : {}),
  });
}

/**
 * Project an Agent Mode conversation's item history onto one Genie message per
 * turn. Items are grouped by their `metadata.message_id`; each turn's user
 * `message` item supplies the question.
 */
export function projectAgentModeConversation(
  spaceId: string,
  conversationId: string,
  items: GenieAgentOutputItem[],
  status = "completed",
): GenieMessage[] {
  const turns: Array<{
    messageId: string;
    question: GenieAgentOutputItem;
    items: GenieAgentOutputItem[];
  }> = [];
  let current: (typeof turns)[number] | undefined;
  for (const item of items) {
    if (item.type === "message" && item.role === "user") {
      const messageId =
        itemMessageId(item) ??
        (item.id?.endsWith("_input") ? item.id.slice(0, -"_input".length) : item.id);
      if (!messageId) continue;
      current = { messageId, question: item, items: [] };
      turns.push(current);
      continue;
    }
    current?.items.push(item);
  }
  return turns.map((turn, index) => {
    const failed = turn.items.some((item) => item.status === "failed");
    const turnStatus = failed ? "failed" : index === turns.length - 1 ? status : "completed";
    return projectAgentModeMessage(
      spaceId,
      contentText(turn.question.content, "input_text").join("\n"),
      {
        id: turn.messageId,
        status: turnStatus,
        conversation_id: conversationId,
        ...(turn.question.created_at !== undefined ? { created_at: turn.question.created_at } : {}),
      },
      turn.items,
    );
  });
}

function itemMetadata(item: GenieAgentOutputItem): Record<string, unknown> | undefined {
  return isRecord(item.metadata) ? item.metadata : undefined;
}

function itemMessageId(item: GenieAgentOutputItem): string | undefined {
  const messageId = itemMetadata(item)?.message_id;
  return typeof messageId === "string" ? messageId : undefined;
}

/** Copy each query output's `statement_id` onto the query attachment it answers. */
function withStatementIds(
  attachments: GenieAttachment[],
  items: GenieAgentOutputItem[],
): GenieAttachment[] {
  const statements = new Map<string, string>();
  for (const item of items) {
    const statementId = itemMetadata(item)?.statement_id;
    if (item.type === "function_call_output" && item.call_id && typeof statementId === "string") {
      statements.set(item.call_id, statementId);
    }
  }
  return attachments.map((attachment) => {
    const statementId = attachment.query && statements.get(attachment.attachment_id ?? "");
    return statementId && attachment.query
      ? { ...attachment, query: { ...attachment.query, statement_id: statementId } }
      : attachment;
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
    const callId = item.call_id ?? item.id;
    const argumentsValue = parseRecord(item.arguments);
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
            attachment_id: callId,
            attachment_type: "query",
            query: {
              id: callId,
              query,
              ...(title ? { title } : {}),
            },
          },
        ]
      : [];
  }
  if (item.type === "function_call_output" && item.output !== undefined) {
    const viz = itemMetadata(item)?.viz;
    if (isRecord(viz) && typeof viz.attachment_id === "string") {
      return [
        {
          attachment_id: viz.attachment_id,
          attachment_type: "viz",
          viz: {
            ...(item.output ? { title: item.output } : {}),
            ...(typeof viz.query_attachment_id === "string"
              ? { query_attachment_id: viz.query_attachment_id }
              : {}),
          },
        },
      ];
    }
    return [textAttachment(id, item.output, item.metadata)];
  }
  if (item.type === "message") {
    return (item.content ?? []).flatMap((part) =>
      part.type === "output_text" &&
      (part.text !== undefined || visualizationAttachmentId(part.metadata))
        ? [textAttachment(id, part.text ?? "", part.metadata)]
        : [],
    );
  }
  return [];
}

function visualizationAttachmentId(metadata: unknown): string | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.viz)) return undefined;
  return typeof metadata.viz.attachment_id === "string" ? metadata.viz.attachment_id : undefined;
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
