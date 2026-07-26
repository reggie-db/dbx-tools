/**
 * OpenAI Responses API <-> Chat Completions translation.
 *
 * Some clients speak only the Responses API (`POST /v1/responses`) - the Codex
 * CLI is the motivating one. Databricks now also exposes native Responses
 * surfaces (`/serving-endpoints/responses` and `/serving-endpoints/open-responses`),
 * while most endpoints still speak Chat Completions at `/invocations`. This
 * module bridges the two, in both directions:
 *
 *   - {@link responsesToChat} lowers a Responses request body to a chat
 *     completions body (instructions -> system message, typed `input` items ->
 *     `messages`, `tools`/`tool_choice` carried through, function-call outputs
 *     folded back into the transcript).
 *   - {@link chatToResponsesRequest} raises a chat-completions request into a
 *     Responses request (the inverse of {@link responsesToChat}), for routing a
 *     chat client at a Responses-only model like Codex.
 *   - {@link chatToResponse} lifts a non-streaming chat completion back into a
 *     Responses `response` object.
 *   - {@link responseToChatCompletion} lifts a native Responses `response`
 *     back into a chat-completions body (the inverse of {@link chatToResponse}).
 *   - {@link createResponsesStreamTranslator} lifts a streaming chat completion
 *     (an OpenAI SSE `chat.completion.chunk` stream) into the Responses SSE
 *     event stream those clients consume (`response.created`,
 *     `response.output_text.delta`, function-call argument deltas,
 *     `response.completed`).
 *   - {@link readResponsesOutput} reads the other direction: pull the answer
 *     text and citations out of a `response` object returned by an endpoint
 *     that speaks Responses natively (the Databricks native web-search tool).
 *   - {@link sanitizeResponsesTools} keeps only `function` tools on a Responses
 *     request body (for `/open-responses` / Anthropic, which reject Codex
 *     built-ins like `web_search`).
 *   - {@link sanitizeOpenResponsesInput} rewrites `output_*` content part types
 *     in `input` to `input_*`, and drops Claude thinking / reasoning blocks
 *     that Open Responses rejects on replay (`redacted_thinking`, …).
 *
 * Only the surface real clients exercise is translated; unknown fields are
 * ignored rather than rejected, so a newer client degrades instead of breaking.
 *
 * Browser-safe: pure functions over plain JSON, no transport and no Node
 * built-ins, so the same translation runs in a proxy, a server route, or a test.
 *
 * @module
 */

import { type ChatMessage, chatContentToText } from "./openai-chat";

/**
 * Lower a Responses request body to a chat-completions body. Returns the chat
 * body plus whether the caller asked for streaming (the server needs it to pick
 * the upstream `accept` header and the translation path).
 */
export function responsesToChat(body: Record<string, unknown>): {
  chat: Record<string, unknown>;
  stream: boolean;
} {
  const messages: ChatMessage[] = [];

  // `instructions` becomes the leading system message.
  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    messages.push({ role: "system", content: body.instructions });
  }

  // `input` is an array of typed items: messages, function_call, and
  // function_call_output. Fold each into the chat transcript.
  const input = Array.isArray(body.input) ? body.input : [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const type = item.type;

    if (type === "function_call") {
      // A prior tool call the model made; re-attach it to an assistant turn.
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: String(item.call_id ?? item.id ?? ""),
            type: "function",
            function: {
              name: String(item.name ?? ""),
              arguments: typeof item.arguments === "string" ? item.arguments : "{}",
            },
          },
        ],
      });
      continue;
    }

    if (type === "function_call_output") {
      // The tool's result, keyed back to the call it answers.
      messages.push({
        role: "tool",
        tool_call_id: String(item.call_id ?? item.id ?? ""),
        content: typeof item.output === "string" ? item.output : chatContentToText(item.output),
      });
      continue;
    }

    // Default: a message item with a role and typed content.
    const role = typeof item.role === "string" ? item.role : "user";
    // Chat has no "developer" role; treat it as system (its intent here).
    const chatRole = role === "developer" ? "system" : role;
    messages.push({ role: chatRole, content: chatContentToText(item.content) });
  }

  const chat: Record<string, unknown> = {
    model: body.model,
    messages,
    stream: body.stream === true,
  };

  // Carry through function-calling config when present. Responses function
  // tools are FLAT (`{type:"function", name, description, parameters}`); chat
  // wants them NESTED (`{type:"function", function:{name, …}}`). Clients also
  // send built-in tool types (local_shell, web_search, …) that Databricks chat
  // rejects ("Missing 'function' in the tool specification"), so we translate
  // only function tools and drop the rest.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const chatTools = body.tools
      .map((t) => {
        const tool = t as Record<string, unknown>;
        // Already chat-nested (`function` object present): pass through.
        if (tool.type === "function" && tool.function && typeof tool.function === "object") {
          return tool;
        }
        // Flat Responses function tool: nest it.
        if (tool.type === "function" && typeof tool.name === "string") {
          return {
            type: "function",
            function: {
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              ...(tool.parameters ? { parameters: tool.parameters } : {}),
            },
          };
        }
        return undefined; // non-function built-in tool: unsupported upstream, drop
      })
      .filter((t): t is Record<string, unknown> => t !== undefined);
    if (chatTools.length > 0) {
      chat.tools = chatTools;
      if (body.tool_choice !== undefined) chat.tool_choice = body.tool_choice;
      // NOTE: do NOT forward `parallel_tool_calls`. Clients send it, but
      // Databricks Model Serving's chat API rejects unknown fields
      // ("parallel_tool_calls: Extra inputs are not permitted"), which would
      // fail the whole turn. Drop it.
    }
  }

  return { chat, stream: body.stream === true };
}

/**
 * Raise a chat-completions request into a Responses request body. Inverse of
 * {@link responsesToChat}: used when a chat client hits a Responses-only
 * Databricks model (e.g. Codex) so the proxy can POST to
 * `/serving-endpoints/responses` without the client knowing.
 */
export function chatToResponsesRequest(body: Record<string, unknown>): {
  responses: Record<string, unknown>;
  stream: boolean;
} {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input: unknown[] = [];
  let instructions: string | undefined;

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "user";

    // Leading system / developer messages become top-level `instructions`.
    if ((role === "system" || role === "developer") && instructions === undefined && input.length === 0) {
      const text = chatContentToText(message.content);
      if (text) instructions = text;
      continue;
    }

    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: String(message.tool_call_id ?? ""),
        output: chatContentToText(message.content),
      });
      continue;
    }

    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      for (const rawCall of message.tool_calls) {
        if (!rawCall || typeof rawCall !== "object") continue;
        const call = rawCall as Record<string, unknown>;
        const fn = (call.function ?? {}) as Record<string, unknown>;
        input.push({
          type: "function_call",
          call_id: String(call.id ?? ""),
          name: String(fn.name ?? ""),
          arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
        });
      }
      const text = chatContentToText(message.content);
      if (text) {
        input.push({ type: "message", role: "assistant", content: text });
      }
      continue;
    }

    input.push({
      type: "message",
      role,
      content: chatContentToText(message.content),
    });
  }

  const responses: Record<string, unknown> = {
    model: body.model,
    input,
    stream: body.stream === true,
  };
  if (instructions) responses.instructions = instructions;

  // Chat tools are nested (`function: { name, … }`); Responses wants them flat.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = body.tools
      .map((t) => {
        if (!t || typeof t !== "object") return undefined;
        const tool = t as Record<string, unknown>;
        if (tool.type !== "function") return undefined;
        if (tool.function && typeof tool.function === "object") {
          const fn = tool.function as Record<string, unknown>;
          return {
            type: "function",
            name: fn.name,
            ...(fn.description ? { description: fn.description } : {}),
            ...(fn.parameters ? { parameters: fn.parameters } : {}),
          };
        }
        if (typeof tool.name === "string") return tool;
        return undefined;
      })
      .filter((t): t is Record<string, unknown> => t !== undefined);
    if (tools.length > 0) {
      responses.tools = tools;
      if (body.tool_choice !== undefined) responses.tool_choice = body.tool_choice;
    }
  }

  // Prefer Responses' max_output_tokens naming; fall back from chat max_tokens.
  if (typeof body.max_output_tokens === "number") {
    responses.max_output_tokens = body.max_output_tokens;
  } else if (typeof body.max_tokens === "number") {
    responses.max_output_tokens = body.max_tokens;
  }

  return { responses, stream: body.stream === true };
}

/** Lift a non-streaming chat completion JSON into a Responses `response` object. */
export function chatToResponse(chat: Record<string, unknown>, model: string): unknown {
  const choices = Array.isArray(chat.choices) ? chat.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first.message ?? {}) as Record<string, unknown>;
  const output: unknown[] = [];

  const text = typeof message.content === "string" ? message.content : "";
  if (text) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    });
  }

  // Surface any tool calls as Responses `function_call` output items.
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const raw of toolCalls) {
    const call = raw as Record<string, unknown>;
    const fn = (call.function ?? {}) as Record<string, unknown>;
    output.push({
      type: "function_call",
      call_id: String(call.id ?? ""),
      name: String(fn.name ?? ""),
      arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
    });
  }

  const usage = (chat.usage ?? {}) as Record<string, unknown>;
  return {
    id: String(chat.id ?? "resp"),
    object: "response",
    created_at: typeof chat.created === "number" ? chat.created : 0,
    model,
    status: "completed",
    output,
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0),
      output_tokens: Number(usage.completion_tokens ?? 0),
      total_tokens: Number(usage.total_tokens ?? 0),
    },
  };
}

/**
 * Lift a native Responses `response` object into a chat-completions body.
 * Inverse of {@link chatToResponse}: used after a Responses-only upstream call
 * when the client spoke Chat Completions.
 */
export function responseToChatCompletion(
  response: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const { text } = readResponsesOutput(response);
  const toolCalls: unknown[] = [];
  const output = Array.isArray(response.output) ? response.output : [];
  for (const raw of output) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type !== "function_call") continue;
    toolCalls.push({
      id: String(item.call_id ?? item.id ?? ""),
      type: "function",
      function: {
        name: String(item.name ?? ""),
        arguments: typeof item.arguments === "string" ? item.arguments : "{}",
      },
    });
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: text || null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const usage = (response.usage ?? {}) as Record<string, unknown>;
  return {
    id: String(response.id ?? "chatcmpl"),
    object: "chat.completion",
    created: typeof response.created_at === "number" ? response.created_at : 0,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: Number(usage.input_tokens ?? 0),
      completion_tokens: Number(usage.output_tokens ?? 0),
      total_tokens: Number(usage.total_tokens ?? 0),
    },
  };
}

/** One Server-Sent Event, ready to write to the client. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Incremental chat-chunk -> Responses-SSE translator. `feed` and `finish` both
 * return the SSE bytes to forward, or `""` when a chunk produced no event.
 */
export interface ResponsesStreamTranslator {
  /** Translate one upstream `chat.completion.chunk` object. */
  feed(chunk: Record<string, unknown>): string;
  /** Close any open items and emit `response.completed`. Call once, at end of stream. */
  finish(): string;
}

/**
 * Translate an upstream chat-completions SSE stream into the Responses SSE
 * event stream a Responses client consumes.
 *
 * Upstream chunks are `chat.completion.chunk` objects whose `choices[0].delta`
 * carries incremental `content` (assistant text) and/or `tool_calls` (function
 * calls, streamed by `index` with partial `arguments`). We emit the Responses
 * lifecycle around them:
 *
 *   response.created
 *   -> per text run:  output_item.added → output_text.delta* → output_item.done
 *   -> per tool call: output_item.added → function_call_arguments.delta*
 *                       → function_call_arguments.done → output_item.done
 *   response.completed   (with the assembled final `response` object)
 *
 * The translator is intentionally tolerant: malformed/keepalive lines yield
 * nothing.
 */
export function createResponsesStreamTranslator(
  model: string,
  responseId: string,
): ResponsesStreamTranslator {
  let started = false;
  let outputIndex = 0;

  // Text run state: whether a message item is currently open, and its buffer.
  let textOpen = false;
  let textBuffer = "";
  let textItemId = "";

  // Tool-call state, keyed by the upstream `tool_calls[].index`.
  interface ToolState {
    outputIndex: number;
    callId: string;
    name: string;
    args: string;
  }
  const tools = new Map<number, ToolState>();

  const created = () =>
    sse("response.created", {
      type: "response.created",
      response: { id: responseId, object: "response", status: "in_progress", model, output: [] },
    });

  function openText(): string {
    textOpen = true;
    textItemId = `${responseId}-msg-${outputIndex}`;
    const ev = sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { id: textItemId, type: "message", role: "assistant", content: [] },
    });
    return ev;
  }

  function closeText(): string {
    if (!textOpen) return "";
    const item = {
      id: textItemId,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: textBuffer }],
    };
    const ev =
      sse("response.output_text.done", {
        type: "response.output_text.done",
        item_id: textItemId,
        output_index: outputIndex,
        content_index: 0,
        text: textBuffer,
      }) +
      sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      });
    textOpen = false;
    textBuffer = "";
    outputIndex += 1;
    return ev;
  }

  function feed(chunk: Record<string, unknown>): string {
    let out = "";
    if (!started) {
      started = true;
      out += created();
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    const delta = (choice.delta ?? {}) as Record<string, unknown>;

    // Assistant text deltas.
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!textOpen) out += openText();
      textBuffer += delta.content;
      out += sse("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: textItemId,
        output_index: outputIndex,
        content_index: 0,
        delta: delta.content,
      });
    }

    // Tool-call deltas: each is keyed by `index`; `arguments` arrives in pieces.
    const toolDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const rawTc of toolDeltas) {
      const tc = rawTc as Record<string, unknown>;
      const idx = Number(tc.index ?? 0);
      const fn = (tc.function ?? {}) as Record<string, unknown>;
      let state = tools.get(idx);
      if (!state) {
        // First fragment for this call: a text run (if open) must close first so
        // output ordering stays monotonic, then we open a function_call item.
        out += closeText();
        state = {
          outputIndex,
          callId: String(tc.id ?? `${responseId}-call-${idx}`),
          name: String(fn.name ?? ""),
          args: "",
        };
        tools.set(idx, state);
        out += sse("response.output_item.added", {
          type: "response.output_item.added",
          output_index: state.outputIndex,
          item: {
            id: state.callId,
            type: "function_call",
            call_id: state.callId,
            name: state.name,
            arguments: "",
          },
        });
        outputIndex += 1;
      }
      if (typeof fn.name === "string" && fn.name && !state.name) state.name = fn.name;
      if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
        state.args += fn.arguments;
        out += sse("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: state.callId,
          output_index: state.outputIndex,
          delta: fn.arguments,
        });
      }
    }
    return out;
  }

  function finish(): string {
    let out = closeText();
    // Close any open tool calls, emitting their assembled arguments.
    for (const state of tools.values()) {
      out += sse("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: state.callId,
        output_index: state.outputIndex,
        arguments: state.args,
      });
      out += sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: state.outputIndex,
        item: {
          id: state.callId,
          type: "function_call",
          call_id: state.callId,
          name: state.name,
          arguments: state.args,
        },
      });
    }
    out += sse("response.completed", {
      type: "response.completed",
      response: { id: responseId, object: "response", status: "completed", model },
    });
    return out;
  }

  return { feed, finish };
}

/** A source the model cited, as carried by a Responses content-part annotation. */
export interface ResponsesCitation {
  url: string;
  title?: string;
}

/** What {@link readResponsesOutput} pulls out of a `response` object. */
export interface ResponsesOutput {
  /** The assistant's answer, with the output items concatenated. */
  text: string;
  /** Cited sources in first-seen order, deduplicated by URL. */
  citations: ResponsesCitation[];
}

/**
 * Read the answer text and cited sources out of a Responses `response` payload.
 *
 * This is the inverse of {@link chatToResponse}: it consumes what an endpoint
 * speaking Responses natively returns, rather than producing it. The Databricks
 * native web-search tool answers this way, with each source attached as a
 * `url_citation` annotation on the content part that used it.
 *
 * Prefers the flattened `output_text` when the payload carries it, and falls
 * back to walking `output[].content[].text`. Every field is optional upstream,
 * so a payload missing any of it yields empty results rather than throwing.
 */
export function readResponsesOutput(payload: Record<string, unknown>): ResponsesOutput {
  const output = Array.isArray(payload.output) ? (payload.output as unknown[]) : [];
  const texts: string[] = [];
  const citations: ResponsesCitation[] = [];
  const seen = new Set<string>();

  for (const rawItem of output) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const content = (rawItem as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const rawPart of content) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as Record<string, unknown>;
      const text = str(part.text);
      if (text) texts.push(text);
      const annotations = Array.isArray(part.annotations) ? part.annotations : [];
      for (const rawAnn of annotations) {
        if (!rawAnn || typeof rawAnn !== "object") continue;
        const ann = rawAnn as Record<string, unknown>;
        const url = str(ann.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const title = str(ann.title);
        citations.push({ url, ...(title ? { title } : {}) });
      }
    }
  }

  return { text: str(payload.output_text) || texts.join("\n").trim(), citations };
}

/** Coerce an unknown JSON value to a trimmed string, or `""` when it isn't one. */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Strip tool types the upstream model doesn't support from a Responses request
 * body, returning a shallow copy safe to forward (the input is not mutated).
 *
 * Clients like the Codex CLI include built-in Responses tools (`web_search`,
 * `local_shell`, `custom`, ...) alongside their `function` tools. Databricks'
 * Open Responses surface for Anthropic/Claude (and other non-OpenAI providers)
 * only accepts `function` tools and hard-errors otherwise:
 *   "Anthropic does not support tool type 'web_search'. Only 'function' is supported."
 * Call this before forwarding to `/serving-endpoints/open-responses`. The OpenAI
 * `/serving-endpoints/responses` path should keep built-ins (GPT supports them).
 * If filtering empties the list, `tools` / `tool_choice` / `parallel_tool_calls`
 * are dropped so we never send an empty `tools: []`.
 */
export function sanitizeResponsesTools(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return body;
  const fnTools = body.tools.filter(
    (t) => t && typeof t === "object" && (t as Record<string, unknown>).type === "function",
  );
  if (fnTools.length === body.tools.length) return body; // nothing to strip
  const next: Record<string, unknown> = { ...body };
  if (fnTools.length > 0) {
    next.tools = fnTools;
  } else {
    delete next.tools;
    delete next.tool_choice;
    delete next.parallel_tool_calls;
  }
  return next;
}

/** Content part / input item types Claude extended-thinking uses on the wire. */
const REASONING_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);

/**
 * Rewrite Responses `input` so Open Responses will accept it.
 *
 * Two OpenAI / Codex shapes that Databricks Open Responses (Claude, Gemini, …)
 * reject:
 *
 * 1. Prior assistant turns with `output_text` / `output_*` content parts —
 *    Open Responses only allows `input_text`, `input_image`, `input_file`,
 *    `input_audio`. Map every `output_<kind>` part to `input_<kind>`.
 * 2. Replayed extended-thinking blocks (`thinking`, `redacted_thinking`,
 *    `reasoning` content parts, and top-level `reasoning` input items). Claude
 *    signs those; any client round-trip that mutates them (or a cross-provider
 *    replay) fails with e.g.
 *      "messages.N.content.M: Invalid `data` in `redacted_thinking` block"
 *    Strip them — the UI/client already showed the thinking; replay does not
 *    need the signed blob. Same policy as appkit-mastra's serving sanitize.
 *
 * Returns a shallow copy when anything changes; otherwise the input body.
 */
export function sanitizeOpenResponsesInput(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(body.input) || body.input.length === 0) return body;

  let changed = false;
  const input: unknown[] = [];

  for (const raw of body.input) {
    if (!raw || typeof raw !== "object") {
      input.push(raw);
      continue;
    }
    const item = raw as Record<string, unknown>;

    // Top-level Responses reasoning items (not message content parts).
    if (typeof item.type === "string" && REASONING_TYPES.has(item.type)) {
      changed = true;
      continue;
    }

    if (!Array.isArray(item.content)) {
      input.push(raw);
      continue;
    }

    let partChanged = false;
    const content: unknown[] = [];
    for (const part of item.content) {
      if (!part || typeof part !== "object") {
        content.push(part);
        continue;
      }
      const p = part as Record<string, unknown>;
      if (typeof p.type === "string" && REASONING_TYPES.has(p.type)) {
        partChanged = true;
        continue;
      }
      if (typeof p.type === "string" && p.type.startsWith("output_")) {
        partChanged = true;
        content.push({ ...p, type: `input_${p.type.slice("output_".length)}` });
        continue;
      }
      content.push(part);
    }

    if (!partChanged) {
      input.push(raw);
      continue;
    }
    changed = true;
    // Drop assistant turns that only carried thinking (nothing left to replay).
    if (content.length === 0 && item.role === "assistant") continue;
    input.push({ ...item, content });
  }

  return changed ? { ...body, input } : body;
}

/**
 * Full Open Responses request sanitizer: strip non-`function` tools, rewrite
 * `output_*` content parts, and drop thinking / reasoning blocks. Safe no-op
 * when nothing needs changing.
 */
export function sanitizeOpenResponsesRequest(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeOpenResponsesInput(sanitizeResponsesTools(body));
}
