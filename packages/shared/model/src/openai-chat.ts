/**
 * OpenAI Chat Completions wire shapes, as Databricks Model Serving speaks them.
 *
 * These are the request/reply payload types for `/chat/completions` and a
 * serving endpoint's `invocations` URL. They are deliberately declared here
 * rather than imported from the OpenAI or AI SDK packages: both keep these
 * fields under internal namespaces that are not part of their public API,
 * whereas the wire payload itself is the stable contract every caller in this
 * repo actually codes against.
 *
 * Pure types plus one text-flattening helper - no zod, no runtime deps - so a
 * browser client, a Node proxy, and an AppKit plugin can all agree on the shape
 * without any of them pulling in the others' dependencies.
 *
 * @module
 */

/**
 * The roles OpenAI defines for a chat turn. {@link ChatMessage.role} is typed as
 * a plain string rather than this union, because providers add their own (for
 * example Databricks-hosted Claude replays a `"reasoning"` turn); use this when
 * you want the standard set named.
 */
export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool";

/**
 * One entry of a structured `content` array. Only `type` and `text` are read
 * here; the index signature keeps provider-specific parts (images, thinking
 * blocks, cache markers) intact through a parse/serialize round trip.
 */
export interface ChatContentPart {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

/** The function a tool call invokes, with its arguments as a JSON string. */
export interface ChatToolCallFunction {
  name: string;
  /** JSON-encoded argument object. Streamed in fragments, so assemble before parsing. */
  arguments: string;
}

/** One tool call attached to an assistant turn. */
export interface ChatToolCall {
  id: string;
  /** `"function"` in practice; widened so an unrecognized type round-trips. */
  type: string;
  function: ChatToolCallFunction;
}

/**
 * A single chat message. `content` is nullable because an assistant turn that
 * only calls tools carries `content: null`.
 */
export interface ChatMessage {
  /** See {@link ChatRole} for the standard values; widened for provider extensions. */
  role: string;
  content?: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  /** Set on a `tool` turn, keying it back to the call it answers. */
  tool_call_id?: string;
  name?: string;
}

/**
 * Top-level request fields an OpenAI client may send that Databricks Model
 * Serving rejects outright, failing the whole turn rather than ignoring them.
 *
 * Databricks validates the chat body strictly, so an unrecognized key comes
 * back as `parallel_tool_calls: Extra inputs are not permitted` (the
 * gateway's pydantic validation) or `json: unknown field "parallel_tool_calls"`
 * (its strict JSON decode), depending on the endpoint. Everything listed here
 * is either OpenAI-platform bookkeeping with no bearing on the completion, or -
 * in the case of `parallel_tool_calls` - a real setting Databricks has no way
 * to accept, so dropping it is the only way the request can succeed at all.
 *
 * Callers that translate a request field-by-field (an allowlist, as
 * `openaiResponses.responsesToChat` does) never need this; it exists for the
 * paths that forward a client body largely as-is.
 */
export const UNSUPPORTED_CHAT_FIELDS: readonly string[] = [
  // Tool-calling concurrency hint. Databricks rejects it; the upstream provider
  // decides parallelism itself.
  "parallel_tool_calls",
  // Response-persistence and bookkeeping fields for OpenAI's own platform.
  "store",
  "metadata",
  "service_tier",
  "prompt_cache_key",
  "safety_identifier",
];

/**
 * Delete the fields Databricks rejects from a chat request body, in place.
 * Returns the names actually removed so a caller can log what it dropped.
 *
 * @param body - Parsed chat request body. Mutated.
 * @param extra - Additional field names to drop, for a workspace or endpoint
 *   that rejects something not yet in {@link UNSUPPORTED_CHAT_FIELDS}.
 */
export function stripUnsupportedChatFields(
  body: Record<string, unknown>,
  extra: readonly string[] = [],
): string[] {
  const dropped: string[] = [];
  for (const field of [...UNSUPPORTED_CHAT_FIELDS, ...extra]) {
    if (!(field in body)) continue;
    delete body[field];
    dropped.push(field);
  }
  return dropped;
}

/** Options for {@link chatContentToText}. */
export interface ChatContentToTextOptions {
  /**
   * Placed between parts. Defaults to `""`, which reassembles a message that was
   * split purely for transport; pass `"\n\n"` when the parts are separate
   * paragraphs that a human will read.
   */
  separator?: string;
  /**
   * Restrict to these `type` values. Defaults to accepting any part carrying
   * `text`, which covers the `input_text` / `output_text` / `text` spellings
   * different APIs use for the same thing.
   */
  types?: readonly string[];
}

/**
 * Flatten a message `content` value to plain text. Accepts the string form and
 * the structured-parts form ({@link ChatContentPart}), and yields `""` for
 * anything else (null, a lone image part, a malformed payload). Typed as
 * `unknown` because most callers are reading a just-parsed JSON body, and the
 * point of this helper is that they do not have to pre-check it.
 */
export function chatContentToText(
  content: unknown,
  options: ChatContentToTextOptions = {},
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const { separator = "", types } = options;
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as ChatContentPart;
    if (types && (typeof part.type !== "string" || !types.includes(part.type))) continue;
    if (typeof part.text === "string") parts.push(part.text);
  }
  return parts.join(separator);
}
