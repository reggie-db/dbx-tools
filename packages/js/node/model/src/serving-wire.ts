/**
 * Framework-neutral repairs for OpenAI Chat traffic sent through Databricks
 * Model Serving.
 *
 * @module
 */

import { json, stringUtils } from "@dbx-tools/shared-core";
import { type ChatMessage, type ChatRole, openaiChat } from "@dbx-tools/shared-model";

import { chatToolReasoningEffort } from "./policy.ts";

/** Chat message plus provider reasoning fields emitted by Databricks models. */
export interface ServingChatMessage extends ChatMessage {
  role: ChatRole | "reasoning";
  reasoning?: unknown;
  reasoning_content?: unknown;
}

/** Prepared fetch arguments and the sanitized request body. */
export interface RewrittenServingRequest {
  input: Parameters<typeof fetch>[0];
  init: Parameters<typeof fetch>[1];
  body: string;
}

const REASONING_PART_TYPES: ReadonlySet<string> = new Set([
  "reasoning",
  "thinking",
  "redacted_thinking",
]);

/** Sanitize a serialized Chat Completions request when provider quirks require it. */
export function rewriteServingBody(body: string): string {
  const parsed = json.parseRecord(body);
  if (!parsed) return body;
  let changed =
    openaiChat.stripUnsupportedChatFields(parsed).length > 0 ||
    applyToolReasoningCompatibility(parsed);
  if (Array.isArray(parsed.messages)) {
    const messages = parsed.messages as ServingChatMessage[];
    const stripped = stripReasoningFromServingMessages(messages);
    const repaired = repairAssistantPrefill(messages);
    changed = changed || stripped || repaired;
  }
  return changed ? JSON.stringify(parsed) : body;
}

/** Read and sanitize a Chat Completions request without retaining stale byte headers. */
export async function rewriteServingRequest(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<RewrittenServingRequest> {
  const request = new Request(input, init);
  const body = await request.clone().text();
  const rewritten = rewriteServingBody(body);
  if (rewritten === body) return { input, init, body };
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return {
    input: new Request(request, { body: rewritten, headers }),
    init: undefined,
    body: rewritten,
  };
}

/** Normalize Chat Completions reasoning for GPT tool calls. */
export function applyToolReasoningCompatibility(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return false;
  const model = stringUtils.trimToNull(body.model);
  if (!model || chatToolReasoningEffort(model) !== "none") return false;
  if (body.reasoning_effort === "none") return false;
  body.reasoning_effort = "none";
  return true;
}

/** Remove provider reasoning blocks that cannot be replayed safely. */
export function stripReasoningFromServingMessages(messages: ServingChatMessage[]): boolean {
  let changed = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "reasoning") {
      messages.splice(index, 1);
      changed = true;
      continue;
    }
    if (message.reasoning !== undefined) {
      delete message.reasoning;
      changed = true;
    }
    if (message.reasoning_content !== undefined) {
      delete message.reasoning_content;
      changed = true;
    }
    const parts = openaiChat.chatContentParts(message.content);
    if (!parts) continue;
    const filtered = parts.filter((part) => {
      const type = part?.type;
      if (typeof type !== "string" || !REASONING_PART_TYPES.has(type)) return true;
      changed = true;
      return false;
    });
    if (filtered.length !== parts.length) message.content = filtered;
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (message.role === "assistant" && !hasToolCalls && isEmptyServingContent(message.content)) {
      messages.splice(index, 1);
      changed = true;
    }
  }
  return changed;
}

/** Fold a trailing assistant prefill back into its preceding tool-call turn. */
export function repairAssistantPrefill(messages: ServingChatMessage[]): boolean {
  if (messages.length < 2) return false;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || (last.tool_calls && last.tool_calls.length > 0)) {
    return false;
  }
  let index = messages.length - 2;
  while (index >= 0 && messages[index]?.role === "tool") index--;
  const opener = messages[index];
  if (
    !opener ||
    opener.role !== "assistant" ||
    !opener.tool_calls ||
    opener.tool_calls.length === 0
  ) {
    return false;
  }
  opener.content = [
    stringUtils.trimToNull(textFromServingContent(opener.content)),
    stringUtils.trimToNull(textFromServingContent(last.content)),
  ]
    .filter((value): value is string => value !== null)
    .join("\n\n");
  messages.pop();
  return true;
}

/** Normalize array-valued content in a non-streaming Chat Completions response. */
export function rewriteServingResponseBody(body: string): string {
  const parsed = json.parseRecord(body);
  if (!parsed) return body;
  return flattenChoiceMessageContent(parsed) ? JSON.stringify(parsed) : body;
}

/** Normalize array-valued content in an SSE stream without buffering the stream. */
export function rewriteServingResponseStream(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline + 1);
          buffer = buffer.slice(newline + 1);
          controller.enqueue(encoder.encode(rewriteServingResponseStreamLine(line)));
          newline = buffer.indexOf("\n");
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) controller.enqueue(encoder.encode(rewriteServingResponseStreamLine(buffer)));
      },
    }),
  );
}

/** Flatten Chat Completions `choices[].message.content` arrays to strings. */
export function flattenChoiceMessageContent(payload: Record<string, unknown>): boolean {
  return flattenChoiceContent(payload, "message");
}

/** Flatten Chat Completions `choices[].delta.content` arrays to strings. */
export function flattenChoiceDeltaContent(payload: Record<string, unknown>): boolean {
  return flattenChoiceContent(payload, "delta");
}

function rewriteServingResponseStreamLine(line: string): string {
  const lineEnding = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
  const content = lineEnding ? line.slice(0, -lineEnding.length) : line;
  const match = /^(data:\s*)(.*)$/.exec(content);
  if (!match || match[2] === "[DONE]") return line;
  const parsed = json.parseRecord(match[2]);
  if (!parsed || !flattenChoiceDeltaContent(parsed)) return line;
  return `${match[1]}${JSON.stringify(parsed)}${lineEnding}`;
}

function flattenChoiceContent(
  payload: Record<string, unknown>,
  field: "message" | "delta",
): boolean {
  if (!Array.isArray(payload.choices)) return false;
  let changed = false;
  for (const choice of payload.choices) {
    if (!choice || typeof choice !== "object") continue;
    const container = (choice as Record<string, unknown>)[field];
    if (!container || typeof container !== "object") continue;
    const target = container as { content?: unknown };
    const parts = openaiChat.chatContentParts(target.content);
    if (!parts) continue;
    target.content = openaiChat.chatContentToText(parts, { types: ["text"] });
    changed = true;
  }
  return changed;
}

function textFromServingContent(content: ServingChatMessage["content"]): string {
  return openaiChat.chatContentToText(content, { separator: "\n\n", types: ["text"] });
}

function isEmptyServingContent(content: ServingChatMessage["content"]): boolean {
  if (content === undefined) return true;
  if (typeof content === "string") return content.trim().length === 0;
  const parts = openaiChat.chatContentParts(content);
  if (!parts) return true;
  return parts.every((part) => {
    if (part?.type === "text") {
      return typeof part.text !== "string" || part.text.trim().length === 0;
    }
    return false;
  });
}
