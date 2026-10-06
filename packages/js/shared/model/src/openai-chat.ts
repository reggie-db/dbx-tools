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
 * @module
 */

import { z } from "zod";

export const ChatRoleSchema = z
  .enum(["system", "developer", "user", "assistant", "tool"])
  .describe(
    "Standard OpenAI chat roles. Message.role stays a plain string because providers add values such as reasoning.",
  );

export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatContentPartSchema = z
  .object({
    type: z
      .string()
      .optional()
      .describe("Part discriminator, such as text, input_text, or output_text."),
    text: z.string().optional().describe("Plain-text payload carried by this part when present."),
  })
  .catchall(z.unknown())
  .describe(
    "One entry of a structured content array. Extra provider keys round-trip through the catch-all.",
  );

export type ChatContentPart = z.infer<typeof ChatContentPartSchema>;

export const ChatToolCallFunctionSchema = z
  .object({
    name: z.string().describe("Function name the model wants to invoke."),
    arguments: z
      .string()
      .describe("JSON-encoded argument object. Streamed in fragments, so assemble before parsing."),
  })
  .describe("The function a tool call invokes, with its arguments as a JSON string.");

export type ChatToolCallFunction = z.infer<typeof ChatToolCallFunctionSchema>;

export const ChatToolCallSchema = z
  .object({
    id: z.string().describe("Tool-call identifier echoed on the matching tool message."),
    type: z
      .string()
      .describe("Tool type. function in practice; widened so unrecognized values round-trip."),
    function: ChatToolCallFunctionSchema.describe(
      "Function name and JSON arguments for this call.",
    ),
  })
  .describe("One tool call attached to an assistant turn.");

export type ChatToolCall = z.infer<typeof ChatToolCallSchema>;

export const ChatMessageSchema = z
  .object({
    role: z
      .string()
      .describe(
        "Message author. See ChatRole for the standard values; widened for provider extensions.",
      ),
    content: z
      .union([z.string(), ChatContentPartSchema, z.array(ChatContentPartSchema)])
      .nullable()
      .optional()
      .describe("Message body. Null when an assistant turn only calls tools."),
    tool_calls: z
      .array(ChatToolCallSchema)
      .optional()
      .describe("Tool calls attached to an assistant turn."),
    tool_call_id: z
      .string()
      .optional()
      .describe("Set on a tool turn, keying it back to the call it answers."),
    name: z.string().optional().describe("Optional speaker or function name."),
  })
  .describe("A single chat message in an OpenAI Chat Completions request or response.");

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

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
 * Callers that translate a request field-by-field through an allowlist never
 * need this; it exists for the
 * paths that forward a client body largely as-is.
 */
export const UNSUPPORTED_CHAT_FIELDS: readonly string[] = [
  "parallel_tool_calls",
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

export const ChatContentToTextOptionsSchema = z
  .object({
    separator: z
      .string()
      .optional()
      .describe("Placed between parts. Defaults to empty, which reassembles transport-split text."),
    types: z
      .array(z.string())
      .optional()
      .describe("Restrict flattening to these part type values when set."),
  })
  .describe("Options for flattening structured chat content to plain text.");

export type ChatContentToTextOptions = z.infer<typeof ChatContentToTextOptionsSchema>;

/**
 * Normalize structured chat content to an array. Providers usually emit a
 * parts array, but some compatibility layers collapse a one-part array to the
 * object itself. Returns `undefined` for strings, nulls, and other scalar
 * values so callers can distinguish structured content from plain text.
 */
export function chatContentParts(content: unknown): ChatContentPart[] | undefined {
  const values = Array.isArray(content)
    ? content
    : content && typeof content === "object"
      ? [content]
      : undefined;
  if (!values) return undefined;
  return values.flatMap((part) => {
    const parsed = ChatContentPartSchema.safeParse(part);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Flatten a message `content` value to plain text. Accepts the string form and
 * structured content as either one {@link ChatContentPart} or an array, and
 * yields `""` for anything else (null, a lone image part, a malformed payload).
 * Typed as `unknown` because most callers are reading a just-parsed JSON body,
 * and the point of this helper is that they do not have to pre-check it.
 */
export function chatContentToText(
  content: unknown,
  options: ChatContentToTextOptions = {},
): string {
  if (typeof content === "string") return content;
  const normalized = chatContentParts(content);
  if (!normalized) return "";
  const { separator = "", types } = ChatContentToTextOptionsSchema.parse(options);
  const parts: string[] = [];
  for (const part of normalized) {
    if (types && (typeof part.type !== "string" || !types.includes(part.type))) continue;
    if (typeof part.text === "string") parts.push(part.text);
  }
  return parts.join(separator);
}
