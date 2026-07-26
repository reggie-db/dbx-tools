import { string } from "@dbx-tools/shared-core";
import { type ChatMessage, type ChatRole, openaiChat } from "@dbx-tools/shared-model";
/**
 * Repairs Mastra / AI SDK message replays sent to Databricks Model
 * Serving before they hit the OpenAI-compatible `/chat/completions`
 * route.
 */

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

const REASONING_PART_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);

/**
 * Parse, sanitize, and re-serialize a `/serving-endpoints/...` POST
 * body. Returns the original string verbatim when the body is not
 * JSON or no rewrite was needed.
 */
export function rewriteServingBody(body: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return body;
  }

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
