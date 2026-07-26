/**
 * OpenAI Responses API <-> Chat Completions translation.
 *
 * The Codex CLI speaks only the Responses API (`POST /v1/responses`), but
 * Databricks serving endpoints speak only Chat Completions (`messages`) at
 * their `invocations` URL. This module bridges the two:
 *
 *   - {@link responsesToChat} lowers a Responses request body to a chat
 *     completions body (instructions -> system message, typed `input` items ->
 *     `messages`, `tools`/`tool_choice` carried through, function-call outputs
 *     folded back into the transcript).
 *   - {@link chatToResponse} lifts a non-streaming chat completion back into a
 *     Responses `response` object.
 *   - {@link chatStreamToResponsesSse} lifts a streaming chat completion (an
 *     OpenAI SSE `chat.completion.chunk` stream) into the Responses SSE event
 *     stream Codex consumes (`response.created`, `response.output_text.delta`,
 *     function-call argument deltas, `response.completed`).
 *
 * Only the surface Codex actually exercises is translated; unknown fields are
 * ignored rather than rejected, so a newer client degrades instead of breaking.
 *
 * @module
 */

/** A minimal chat message as Databricks Model Serving expects it. */
interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Extract plain text from a Responses `content` value (string or typed parts). */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object") {
      const p = part as Record<string, unknown>;
      // input_text / output_text / text all carry their text on `.text`.
      if (typeof p.text === "string") parts.push(p.text);
    }
  }
  return parts.join("");
}

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
        content: typeof item.output === "string" ? item.output : contentToText(item.output),
      });
      continue;
    }

    // Default: a message item with a role and typed content.
    const role = typeof item.role === "string" ? item.role : "user";
    // Chat has no "developer" role; treat it as system (its intent here).
    const chatRole = role === "developer" ? "system" : role;
    messages.push({ role: chatRole, content: contentToText(item.content) });
  }

  const chat: Record<string, unknown> = {
    model: body.model,
    messages,
    stream: body.stream === true,
  };

  // Carry through function-calling config when present. Responses function
  // tools are FLAT (`{type:"function", name, description, parameters}`); chat
  // wants them NESTED (`{type:"function", function:{name, …}}`). Codex also
  // sends built-in tool types (local_shell, web_search, …) that Databricks chat
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
      if (body.parallel_tool_calls !== undefined) {
        chat.parallel_tool_calls = body.parallel_tool_calls;
      }
    }
  }

  return { chat, stream: body.stream === true };
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

/** One Server-Sent Event, ready to write to the client. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Translate an upstream chat-completions SSE stream into the Responses SSE
 * event stream Codex consumes.
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
 * `feed(chunk)` returns the SSE bytes to forward for that upstream chunk;
 * `finish()` returns the closing `response.completed` event. The generator is
 * intentionally tolerant: malformed/keepalive lines yield nothing.
 */
export function createResponsesStreamTranslator(model: string, responseId: string) {
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

