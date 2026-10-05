/**
 * Streaming and buffered protocol encoders for AI SDK fallback results.
 *
 * @module
 */

import type { ClientProtocol } from "@dbx-tools/shared-model-gateway";
import type { FinishReason, LanguageModelUsage, TextStreamPart, ToolSet, TypedToolCall } from "ai";

/** Completed AI SDK generation data used by non-streaming encoders. */
export interface CompletedGeneration {
  readonly text: string;
  readonly toolCalls: readonly TypedToolCall<ToolSet>[];
  readonly usage: LanguageModelUsage;
  readonly finishReason: FinishReason;
}

/** Encode AI SDK events as the requested protocol while preserving backpressure. */
export function encodeGatewayStream(
  protocol: ClientProtocol,
  model: string,
  source: AsyncIterable<TextStreamPart<ToolSet>>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const events =
          protocol === "openai-responses"
            ? responsesEvents(model, source)
            : protocol === "anthropic-messages"
              ? anthropicEvents(model, source)
              : chatEvents(model, source);
        for await (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/** Encode a completed AI SDK generation as one protocol-native JSON response. */
export function encodeGatewayResponse(
  protocol: ClientProtocol,
  model: string,
  generation: CompletedGeneration,
): Record<string, unknown> {
  if (protocol === "openai-responses") return responsesObject(model, generation);
  if (protocol === "anthropic-messages") return anthropicObject(model, generation);
  return chatObject(model, generation);
}

async function* responsesEvents(
  model: string,
  source: AsyncIterable<TextStreamPart<ToolSet>>,
): AsyncGenerator<string> {
  const responseId = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const output: Record<string, unknown>[] = [];
  const response = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    model,
    status: "in_progress",
    background: false,
    completed_at: null,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: null,
    metadata: {},
  };
  let sequenceNumber = 0;
  const event = (name: string, payload: Record<string, unknown>) =>
    sse(name, { ...payload, sequence_number: sequenceNumber++ });
  yield event("response.created", { type: "response.created", response });
  yield event("response.in_progress", { type: "response.in_progress", response });
  let outputIndex = 0;
  let messageId: string | undefined;
  let textValue = "";
  const toolIndexes = new Map<string, number>();
  let usage: LanguageModelUsage | undefined;

  for await (const part of source) {
    if (part.type === "text-start") {
      messageId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
      yield event("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          id: messageId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          phase: "final_answer",
          content: [],
        },
      });
      yield event("response.content_part.added", {
        type: "response.content_part.added",
        item_id: messageId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [], logprobs: [] },
      });
    } else if (part.type === "text-delta") {
      textValue += part.text;
      yield event("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: messageId,
        output_index: outputIndex,
        content_index: 0,
        delta: part.text,
        logprobs: [],
      });
    } else if (part.type === "text-end") {
      yield event("response.output_text.done", {
        type: "response.output_text.done",
        item_id: messageId,
        output_index: outputIndex,
        content_index: 0,
        text: textValue,
        logprobs: [],
      });
      yield event("response.content_part.done", {
        type: "response.content_part.done",
        item_id: messageId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: textValue, annotations: [], logprobs: [] },
      });
      const item = {
        id: messageId,
        type: "message",
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [{ type: "output_text", text: textValue, annotations: [], logprobs: [] }],
      };
      output.push(item);
      yield event("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      });
      outputIndex++;
      textValue = "";
    } else if (part.type === "reasoning-delta") {
      yield event("response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        output_index: outputIndex,
        delta: part.text,
      });
    } else if (part.type === "tool-input-start") {
      toolIndexes.set(part.id, outputIndex);
      yield event("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          id: `fc_${part.id}`,
          type: "function_call",
          call_id: part.id,
          name: part.toolName,
          arguments: "",
          status: "in_progress",
        },
      });
      outputIndex++;
    } else if (part.type === "tool-input-delta") {
      yield event("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: `fc_${part.id}`,
        output_index: toolIndexes.get(part.id) ?? outputIndex,
        delta: part.delta,
      });
    } else if (part.type === "tool-call") {
      const index = toolIndexes.get(part.toolCallId) ?? outputIndex++;
      const item = {
        id: `fc_${part.toolCallId}`,
        type: "function_call",
        call_id: part.toolCallId,
        name: part.toolName,
        arguments: JSON.stringify(part.input),
        status: "completed",
      };
      yield event("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: `fc_${part.toolCallId}`,
        output_index: index,
        arguments: JSON.stringify(part.input),
      });
      yield event("response.output_item.done", {
        type: "response.output_item.done",
        output_index: index,
        item,
      });
      output.push(item);
    } else if (part.type === "finish") {
      usage = part.totalUsage;
    } else if (part.type === "error") {
      yield event("error", protocolError(part.error));
    }
  }
  yield event("response.completed", {
    type: "response.completed",
    response: {
      ...response,
      status: "completed",
      completed_at: Math.floor(Date.now() / 1000),
      usage: responsesUsage(usage),
    },
  });
}

async function* chatEvents(
  model: string,
  source: AsyncIterable<TextStreamPart<ToolSet>>,
): AsyncGenerator<string> {
  const id = `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  yield data({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });
  const toolIndexes = new Map<string, number>();
  let nextToolIndex = 0;
  for await (const part of source) {
    if (part.type === "text-delta") {
      yield data({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
      });
    } else if (part.type === "tool-input-start") {
      const index = nextToolIndex++;
      toolIndexes.set(part.id, index);
      yield data({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: part.id,
                  type: "function",
                  function: { name: part.toolName, arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    } else if (part.type === "tool-input-delta") {
      yield data({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: toolIndexes.get(part.id) ?? 0,
                  function: { arguments: part.delta },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    } else if (part.type === "finish") {
      yield data({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: chatFinishReason(part.finishReason) }],
        usage: chatUsage(part.totalUsage),
      });
    } else if (part.type === "error") {
      yield data(protocolError(part.error));
    }
  }
  yield "data: [DONE]\n\n";
}

async function* anthropicEvents(
  model: string,
  source: AsyncIterable<TextStreamPart<ToolSet>>,
): AsyncGenerator<string> {
  const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  yield sse("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  let contentIndex = 0;
  const toolIndexes = new Map<string, number>();
  for await (const part of source) {
    if (part.type === "text-start") {
      yield sse("content_block_start", {
        type: "content_block_start",
        index: contentIndex,
        content_block: { type: "text", text: "" },
      });
    } else if (part.type === "text-delta") {
      yield sse("content_block_delta", {
        type: "content_block_delta",
        index: contentIndex,
        delta: { type: "text_delta", text: part.text },
      });
    } else if (part.type === "text-end") {
      yield sse("content_block_stop", { type: "content_block_stop", index: contentIndex++ });
    } else if (part.type === "tool-input-start") {
      toolIndexes.set(part.id, contentIndex);
      yield sse("content_block_start", {
        type: "content_block_start",
        index: contentIndex++,
        content_block: { type: "tool_use", id: part.id, name: part.toolName, input: {} },
      });
    } else if (part.type === "tool-input-delta") {
      yield sse("content_block_delta", {
        type: "content_block_delta",
        index: toolIndexes.get(part.id) ?? 0,
        delta: { type: "input_json_delta", partial_json: part.delta },
      });
    } else if (part.type === "tool-input-end") {
      yield sse("content_block_stop", {
        type: "content_block_stop",
        index: toolIndexes.get(part.id) ?? 0,
      });
    } else if (part.type === "finish") {
      yield sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: anthropicFinishReason(part.finishReason), stop_sequence: null },
        usage: { output_tokens: part.totalUsage.outputTokens ?? 0 },
      });
    } else if (part.type === "error") {
      yield sse("error", protocolError(part.error));
    }
  }
  yield sse("message_stop", { type: "message_stop" });
}

function responsesObject(model: string, generation: CompletedGeneration): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  if (generation.text) {
    output.push({
      id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: generation.text, annotations: [] }],
    });
  }
  for (const call of generation.toolCalls) {
    output.push({
      id: `fc_${call.toolCallId}`,
      type: "function_call",
      call_id: call.toolCallId,
      name: call.toolName,
      arguments: JSON.stringify(call.input),
      status: "completed",
    });
  }
  return {
    id: `resp_${crypto.randomUUID().replaceAll("-", "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    usage: responsesUsage(generation.usage),
  };
}

function chatObject(model: string, generation: CompletedGeneration): Record<string, unknown> {
  return {
    id: `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: generation.text || null,
          ...(generation.toolCalls.length > 0
            ? {
                tool_calls: generation.toolCalls.map((call) => ({
                  id: call.toolCallId,
                  type: "function",
                  function: { name: call.toolName, arguments: JSON.stringify(call.input) },
                })),
              }
            : {}),
        },
        finish_reason: chatFinishReason(generation.finishReason),
      },
    ],
    usage: chatUsage(generation.usage),
  };
}

function anthropicObject(model: string, generation: CompletedGeneration): Record<string, unknown> {
  return {
    id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model,
    content: [
      ...(generation.text ? [{ type: "text", text: generation.text }] : []),
      ...generation.toolCalls.map((call) => ({
        type: "tool_use",
        id: call.toolCallId,
        name: call.toolName,
        input: call.input,
      })),
    ],
    stop_reason: anthropicFinishReason(generation.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: generation.usage.inputTokens ?? 0,
      output_tokens: generation.usage.outputTokens ?? 0,
    },
  };
}

function responsesUsage(usage: LanguageModelUsage | undefined): Record<string, unknown> {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cached_tokens: usage?.inputTokenDetails.cacheReadTokens ?? 0 },
    output_tokens_details: {
      reasoning_tokens: usage?.outputTokenDetails.reasoningTokens ?? 0,
    },
  };
}

function chatUsage(usage: LanguageModelUsage): Record<string, number> {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

function chatFinishReason(reason: FinishReason): string {
  if (reason === "tool-calls") return "tool_calls";
  if (reason === "length") return "length";
  if (reason === "content-filter") return "content_filter";
  return "stop";
}

function anthropicFinishReason(reason: FinishReason): string {
  if (reason === "tool-calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

function protocolError(error: unknown): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function data(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
