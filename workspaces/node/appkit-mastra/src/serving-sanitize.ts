/**
 * Repairs traffic between Mastra / the AI SDK and Databricks Model Serving's
 * OpenAI-compatible `/chat/completions` route, in both directions.
 *
 * Outbound ({@link rewriteServingBody}), because the transcript Mastra
 * persists is not always a transcript the provider will accept back:
 * Databricks-hosted Claude rejects replayed extended-thinking blocks and reads
 * a trailing assistant message as a prefill request.
 *
 * Inbound ({@link rewriteServingResponseBody}), because Databricks-hosted
 * Gemini answers with its native content-parts array where the OpenAI contract
 * (and therefore the AI SDK's response schema) requires a plain string.
 *
 * Every repair here is a provider quirk rather than a schema violation, so all
 * of them are applied on the wire (see the `globalThis.fetch` wrapper in
 * `model.ts`) rather than by changing what the agent stores or what the UI
 * shows.
 *
 * @module
 */

import { json, string } from "@dbx-tools/shared-core";
import {
  type ChatMessage,
  type ChatRole,
  openaiChat,
  openaiResponses,
} from "@dbx-tools/shared-model";

/**
 * A chat message as it arrives on the serving wire, plus the extended-thinking
 * fields Databricks-hosted Claude adds. The OpenAI-standard part of the shape
 * is {@link ChatMessage} from `@dbx-tools/shared-model`; only the provider
 * extensions this module strips are declared here.
 */
export interface ServingChatMessage extends ChatMessage {
  /** Narrowed to the roles this repair pass reasons about, plus Claude's `reasoning` turn. */
  role: ChatRole | "reasoning";
  reasoning?: unknown;
  reasoning_content?: unknown;
}

// Shared with the Responses sanitize path so both wire surfaces agree on what
// counts as a signed reasoning block.
const REASONING_PART_TYPES = openaiResponses.REASONING_TYPES;

/**
 * Parse, sanitize, and re-serialize a `/serving-endpoints/...` POST
 * body. Returns the original string verbatim when the body is not
 * JSON or no rewrite was needed.
 */
export function rewriteServingBody(body: string): string {
  const parsed = json.parseRecord(body);
  if (!parsed) return body;

  // Runs regardless of `messages`: Databricks refuses to parse a body carrying
  // an unknown top-level field, so this failure is not specific to a transcript.
  let changed = openaiChat.stripUnsupportedChatFields(parsed).length > 0;

  if (Array.isArray(parsed.messages)) {
    const messages = parsed.messages as ServingChatMessage[];
    // Evaluated eagerly, not short-circuited: one transcript can need both
    // reasoning blocks stripped AND a trailing assistant prefill folded back.
    const stripped = stripReasoningFromServingMessages(messages);
    const repaired = repairAssistantPrefill(messages);
    changed = changed || stripped || repaired;
  }

  return changed ? JSON.stringify(parsed) : body;
}

/**
 * Drop extended-thinking / reasoning blocks from a replayed transcript.
 *
 * Hybrid Claude endpoints (e.g. Sonnet 4.5+) may emit `reasoning` content
 * parts on the first turn. Mastra persists and replays them on the next
 * agent step, but Databricks-hosted Claude rejects those blocks on
 * multi-turn tool continuations. The UI already captured reasoning for
 * display; stripping here keeps provider replay compatible without
 * changing what users see in the chat bubble.
 */
export function stripReasoningFromServingMessages(messages: ServingChatMessage[]): boolean {
  let changed = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === "reasoning") {
      messages.splice(i, 1);
      changed = true;
      continue;
    }
    if (msg.reasoning !== undefined) {
      delete msg.reasoning;
      changed = true;
    }
    if (msg.reasoning_content !== undefined) {
      delete msg.reasoning_content;
      changed = true;
    }
    if (!Array.isArray(msg.content)) continue;
    const filtered = msg.content.filter((part) => {
      const type = part?.type;
      if (typeof type === "string" && REASONING_PART_TYPES.has(type)) {
        changed = true;
        return false;
      }
      return true;
    });
    if (filtered.length !== msg.content.length) {
      msg.content = filtered;
    }
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    if (msg.role === "assistant" && !hasToolCalls && isEmptyServingContent(msg.content)) {
      messages.splice(i, 1);
      changed = true;
    }
  }
  return changed;
}

/**
 * Repair a Mastra/AI SDK message replay that Databricks-hosted Claude
 * rejects with `"This model does not support assistant message
 * prefill. The conversation must end with a user message."`.
 *
 * The bug pattern: when an assistant turn streams text *and* a
 * `tool_call`, the AI SDK persists them as two separate assistant
 * entries (text-only and tool-call-only). On the next agent step the
 * tool-call entry is replayed *before* the tool result and the
 * text entry is replayed *after* it, so the conversation ends with a
 * trailing assistant text message. Anthropic interprets that as a
 * prefill request and rejects it on Databricks (the upstream Bedrock
 * route disallows prefill).
 *
 * Fix: when the last message is an assistant text with no `tool_calls`
 * and the chain immediately before it is `assistant(tool_calls=...)`
 * followed only by `tool(...)` results, fold the trailing text back
 * into the `content` of that opening assistant and drop the duplicate.
 */
export function repairAssistantPrefill(messages: ServingChatMessage[]): boolean {
  if (messages.length < 2) return false;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || (last.tool_calls && last.tool_calls.length > 0)) {
    return false;
  }

  let i = messages.length - 2;
  while (i >= 0 && messages[i]?.role === "tool") i--;
  if (i < 0) return false;
  const opener = messages[i];
  if (
    !opener ||
    opener.role !== "assistant" ||
    !opener.tool_calls ||
    opener.tool_calls.length === 0
  ) {
    return false;
  }

  const merged = [
    string.trimToNull(textFromServingContent(opener.content)),
    string.trimToNull(textFromServingContent(last.content)),
  ]
    .filter((s): s is string => s !== null)
    .join("\n\n");
  opener.content = merged;
  messages.pop();
  return true;
}

/**
 * Flatten content to the prose a human would read: text parts only, separated
 * by blank lines, since the result is spliced into another turn's message body.
 */
function textFromServingContent(content: ServingChatMessage["content"]): string {
  return openaiChat.chatContentToText(content, { separator: "\n\n", types: ["text"] });
}

/**
 * Whether a turn carries nothing worth replaying. Deliberately stricter than
 * "has no text": a part of any other type (an image, a cache marker) counts as
 * content, so a message holding one is kept even though it has no prose.
 */
function isEmptyServingContent(content: ServingChatMessage["content"]): boolean {
  if (content === undefined) return true;
  if (typeof content === "string") return content.trim().length === 0;
  if (!Array.isArray(content)) return true;
  return content.every((part) => {
    if (part?.type === "text") {
      return typeof part.text !== "string" || part.text.trim().length === 0;
    }
    return false;
  });
}

/**
 * Parse, sanitize, and re-serialize a `/serving-endpoints/...` non-streaming
 * JSON RESPONSE body. Returns the original string verbatim when the body is
 * not JSON or no rewrite was needed, mirroring
 * {@link rewriteServingBody} on the request side.
 */
export function rewriteServingResponseBody(body: string): string {
  const parsed = json.parseRecord(body);
  if (!parsed) return body;
  return flattenChoiceMessageContent(parsed) ? JSON.stringify(parsed) : body;
}

/**
 * Collapse a structured `choices[].message.content` array to the plain string
 * the OpenAI Chat Completions contract specifies.
 *
 * Databricks-hosted Gemini answers a non-streaming `/chat/completions` call
 * with the Gemini-native parts shape:
 *
 * ```json
 * "content": [{ "type": "text", "text": "...", "thoughtSignature": "..." }]
 * ```
 *
 * `@ai-sdk/openai-compatible` validates the response against the OpenAI
 * schema, where `content` is a nullable string, so it throws
 * `Type validation failed: ... expected string, received array` and the whole
 * call fails (`AI_APICallError: Invalid JSON response` on an HTTP 200). Mastra
 * uses `doGenerate` for its side calls, so the visible symptom is
 * `Error generating title` - every thread keeps its placeholder name.
 *
 * Flattening on the wire keeps the repair in one place: the streaming path is
 * unaffected (deltas already carry string content), and neither the agent's
 * stored transcript nor the UI has to know the provider emitted parts. Any
 * non-text part (a `thoughtSignature`-only entry, an inline image) contributes
 * nothing, matching {@link openaiChat.chatContentToText}, and an all-parts-empty
 * message flattens to `""` rather than being dropped, so `finish_reason` and
 * `usage` still round-trip.
 */
export function flattenChoiceMessageContent(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.choices)) return false;
  let changed = false;
  for (const choice of payload.choices) {
    if (!choice || typeof choice !== "object") continue;
    const message = (choice as { message?: unknown }).message;
    if (!message || typeof message !== "object") continue;
    const target = message as { content?: unknown };
    if (!Array.isArray(target.content)) continue;
    target.content = openaiChat.chatContentToText(target.content, { types: ["text"] });
    changed = true;
  }
  return changed;
}
