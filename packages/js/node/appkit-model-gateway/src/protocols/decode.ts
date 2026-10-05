/**
 * External OpenAI and Anthropic request decoders for AI SDK fallback routes.
 *
 * @module
 */

import type { ClientProtocol } from "@dbx-tools/shared-model-gateway";
import { dynamicTool, jsonSchema, type ModelMessage, type ToolSet } from "ai";

/** AI SDK call settings decoded from a gateway request. */
export interface DecodedGatewayRequest {
  readonly messages: ModelMessage[];
  readonly tools: ToolSet;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
}

/** Decode one supported external protocol into AI SDK model messages and tools. */
export function decodeGatewayRequest(
  protocol: ClientProtocol,
  body: Readonly<Record<string, unknown>>,
): DecodedGatewayRequest {
  const messages =
    protocol === "openai-responses"
      ? decodeResponsesMessages(body)
      : protocol === "anthropic-messages"
        ? decodeAnthropicMessages(body)
        : decodeChatMessages(body);
  return {
    messages: consolidateSystemMessages(messages),
    tools: decodeTools(body.tools),
    ...numberSetting(body, "max_output_tokens", "max_tokens", "max_tokens_to_sample"),
    ...(finiteNumber(body.temperature) !== undefined
      ? { temperature: finiteNumber(body.temperature) }
      : {}),
    ...(finiteNumber(body.top_p) !== undefined ? { topP: finiteNumber(body.top_p) } : {}),
  };
}

function decodeResponsesMessages(body: Readonly<Record<string, unknown>>): ModelMessage[] {
  const messages: ModelMessage[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
    return messages;
  }
  const toolNames = new Map<string, string>();
  for (const item of arrayRecords(body.input)) {
    const type = item.type;
    if (type === "function_call" || type === "custom_tool_call") {
      const callId = stringValue(item.call_id) ?? stringValue(item.id) ?? crypto.randomUUID();
      const toolName = stringValue(item.name) ?? "tool";
      toolNames.set(callId, toolName);
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: callId,
            toolName,
            input: parseToolInput(item.arguments ?? item.input),
          },
        ],
      } as ModelMessage);
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const callId = stringValue(item.call_id) ?? stringValue(item.id) ?? crypto.randomUUID();
      messages.push(toolResultMessage(callId, toolNames.get(callId) ?? "tool", item.output));
      continue;
    }
    const role = messageRole(item.role);
    if (role) messages.push({ role, content: contentText(item.content) } as ModelMessage);
  }
  return messages;
}

function decodeChatMessages(body: Readonly<Record<string, unknown>>): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const message of arrayRecords(body.messages)) {
    const role = stringValue(message.role);
    if (role === "tool") {
      const callId = stringValue(message.tool_call_id) ?? crypto.randomUUID();
      messages.push(toolResultMessage(callId, toolNames.get(callId) ?? "tool", message.content));
      continue;
    }
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      const content: Record<string, unknown>[] = [];
      const text = contentText(message.content);
      if (text) content.push({ type: "text", text });
      for (const toolCall of arrayRecords(message.tool_calls)) {
        const fn = record(toolCall.function);
        const callId = stringValue(toolCall.id) ?? crypto.randomUUID();
        const toolName = stringValue(fn.name) ?? "tool";
        toolNames.set(callId, toolName);
        content.push({
          type: "tool-call",
          toolCallId: callId,
          toolName,
          input: parseToolInput(fn.arguments),
        });
      }
      messages.push({ role: "assistant", content } as ModelMessage);
      continue;
    }
    const normalized = messageRole(role);
    if (normalized) messages.push({ role: normalized, content: contentText(message.content) });
  }
  return messages;
}

function decodeAnthropicMessages(body: Readonly<Record<string, unknown>>): ModelMessage[] {
  const messages: ModelMessage[] = [];
  if (body.system !== undefined) {
    const system = contentText(body.system);
    if (system) messages.push({ role: "system", content: system });
  }
  const toolNames = new Map<string, string>();
  for (const message of arrayRecords(body.messages)) {
    const role = stringValue(message.role);
    const parts = Array.isArray(message.content) ? message.content : [];
    if (role === "assistant") {
      const content: Record<string, unknown>[] = [];
      for (const part of parts) {
        if (!record(part).type || record(part).type === "text") {
          const text = contentText(part);
          if (text) content.push({ type: "text", text });
          continue;
        }
        const value = record(part);
        if (value.type !== "tool_use") continue;
        const callId = stringValue(value.id) ?? crypto.randomUUID();
        const toolName = stringValue(value.name) ?? "tool";
        toolNames.set(callId, toolName);
        content.push({
          type: "tool-call",
          toolCallId: callId,
          toolName,
          input: value.input ?? {},
        });
      }
      messages.push({ role: "assistant", content } as ModelMessage);
      continue;
    }
    const textParts: string[] = [];
    for (const part of parts) {
      const value = record(part);
      if (value.type === "tool_result") {
        const callId = stringValue(value.tool_use_id) ?? crypto.randomUUID();
        messages.push(toolResultMessage(callId, toolNames.get(callId) ?? "tool", value.content));
      } else {
        const text = contentText(part);
        if (text) textParts.push(text);
      }
    }
    if (textParts.length > 0) messages.push({ role: "user", content: textParts.join("\n") });
  }
  return messages;
}

function decodeTools(value: unknown): ToolSet {
  const tools: ToolSet = {};
  for (const entry of arrayRecords(value)) {
    const fn = record(entry.function);
    const name = stringValue(fn.name) ?? stringValue(entry.name);
    if (!name) continue;
    const declaredSchema = record(fn.parameters ?? entry.input_schema);
    const schema =
      Object.keys(declaredSchema).length > 0
        ? declaredSchema
        : entry.type === "custom"
          ? {
              type: "object",
              properties: { input: { type: "string" } },
              required: ["input"],
              additionalProperties: false,
            }
          : { type: "object", properties: {}, additionalProperties: false };
    tools[name] = dynamicTool({
      description: stringValue(fn.description) ?? stringValue(entry.description),
      inputSchema: jsonSchema(schema),
    });
  }
  return tools;
}

function toolResultMessage(callId: string, toolName: string, output: unknown): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: callId,
        toolName,
        output: { type: "text", value: contentText(output) },
      },
    ],
  } as ModelMessage;
}

function numberSetting(
  body: Readonly<Record<string, unknown>>,
  ...names: readonly string[]
): Pick<DecodedGatewayRequest, "maxOutputTokens"> {
  for (const name of names) {
    const value = finiteNumber(body[name]);
    if (value !== undefined) return { maxOutputTokens: Math.floor(value) };
  }
  return {};
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return { input: value };
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    const text = stringValue(record(value).text);
    return text ?? (value === undefined || value === null ? "" : JSON.stringify(value));
  }
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      const item = record(part);
      return (
        stringValue(item.text) ?? stringValue(item.output_text) ?? stringValue(item.input_text)
      );
    })
    .filter((text): text is string => text !== undefined)
    .join("");
}

function messageRole(value: unknown): "system" | "user" | "assistant" | undefined {
  if (value === "system" || value === "developer") return "system";
  if (value === "user" || value === "assistant") return value;
  return undefined;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function consolidateSystemMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .filter(Boolean)
    .join("\n\n");
  return [
    ...(system ? ([{ role: "system", content: system }] as ModelMessage[]) : []),
    ...messages.filter((message) => message.role !== "system"),
  ];
}
