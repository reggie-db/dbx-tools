/**
 * Forgiving model-context normalization for routing and suggestion generation.
 *
 * @module
 */

import { isRecord } from "@dbx-tools/shared-core";
import {
  convertToModelMessages,
  modelMessageSchema,
  pruneMessages,
  safeValidateUIMessages,
  type ModelMessage,
} from "ai";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

const CONTEXT_ENCODING = new Tiktoken(o200kBase);
const DEFAULT_TOKEN_LIMIT = 4_096;

/** One useful conversational event retained from arbitrary caller input. */
export interface ModelContextEvent {
  readonly role: "assistant" | "system" | "tool" | "user";
  readonly text: string;
}

/** Controls for converting arbitrary values into bounded model context. */
export interface NormalizeModelContextOptions {
  /** Maximum retained tokens. Defaults to 4096. */
  readonly tokenLimit?: number;
  /** Remove reasoning, tool calls/results, metadata, and other non-conversational noise. */
  readonly removeNonUsefulMessages?: boolean;
}

/** Bounded context plus logical-turn metadata used by model routers. */
export interface NormalizedModelContext {
  readonly continuation: boolean;
  readonly events: readonly ModelContextEvent[];
  readonly logicalTurn: string;
  readonly task: string;
  readonly tokenCount: number;
}

/**
 * Normalize strings, JSON, AI SDK messages, Responses input, and task-shaped objects.
 *
 * AI SDK UI/model message parsing is preferred. The fallback handles external wire
 * shapes and arbitrary JSON without retaining credentials, metadata, or tool arguments.
 */
export async function normalizeModelContext(
  input: unknown,
  options: NormalizeModelContextOptions = {},
): Promise<NormalizedModelContext> {
  const tokenLimit = Math.max(0, options.tokenLimit ?? DEFAULT_TOKEN_LIMIT);
  const removeNonUsefulMessages = options.removeNonUsefulMessages ?? true;
  const normalized = parseJsonString(input);
  const conversation = conversationValue(normalized);
  const sdkMessages = await aiSdkModelMessages(conversation);
  const events = sdkMessages
    ? modelMessageEvents(sdkMessages, removeNonUsefulMessages)
    : conversationEvents(conversation, removeNonUsefulMessages);
  const rawEvents = conversationEvents(conversation, false);
  const stateEvents = rawEvents.length > 0 ? rawEvents : events;
  if (events.length > 0) return contextFromEvents(events, tokenLimit, stateEvents);

  const values = collectTaskStrings(normalized);
  const task = truncateText(values.join("\n"), tokenLimit, "start");
  return {
    task,
    logicalTurn: task,
    continuation: false,
    events: task ? [{ role: "user", text: task }] : [],
    tokenCount: countTokens(task),
  };
}

async function aiSdkModelMessages(input: unknown): Promise<ModelMessage[] | undefined> {
  if (!Array.isArray(input) || input.length === 0) return undefined;
  const modelMessages = input.map((value) => modelMessageSchema.safeParse(value));
  if (modelMessages.every((result) => result.success)) {
    return modelMessages.map((result) => result.data);
  }

  const uiMessages = await safeValidateUIMessages({ messages: input });
  if (!uiMessages.success) return undefined;
  try {
    return await convertToModelMessages(uiMessages.data, { ignoreIncompleteToolCalls: true });
  } catch {
    return undefined;
  }
}

function modelMessageEvents(
  messages: ModelMessage[],
  removeNonUsefulMessages: boolean,
): ModelContextEvent[] {
  const useful = removeNonUsefulMessages
    ? pruneMessages({ messages, reasoning: "all", toolCalls: "all" })
    : messages;
  return useful.flatMap((message) => {
    const role = message.role;
    if (role === "tool" && removeNonUsefulMessages) return [];
    const text = modelContentText(message.content, removeNonUsefulMessages);
    return text ? [{ role, text }] : [];
  });
}

function modelContentText(value: unknown, removeNonUsefulMessages: boolean): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      if (!isRecord(part)) return [];
      if (typeof part.text === "string") return [part.text.trim()];
      if (!removeNonUsefulMessages && typeof part.output === "string") return [part.output.trim()];
      return [];
    })
    .filter(Boolean)
    .join("\n");
}

function conversationValue(input: unknown): unknown {
  if (!isRecord(input)) return input;
  for (const key of ["messages", "input"] as const) {
    const value = input[key];
    if (Array.isArray(value)) return value;
    if (typeof value === "string" && value.trim()) return value;
  }
  return input;
}

function contextFromEvents(
  events: readonly ModelContextEvent[],
  tokenLimit: number,
  stateEvents: readonly ModelContextEvent[] = events,
): NormalizedModelContext {
  const latestUserIndex = lastEventIndex(events, "user");
  const taskEvent = latestUserIndex >= 0 ? events[latestUserIndex] : events.at(-1);
  const task = truncateText(taskEvent?.text ?? "", tokenLimit, "start");
  let remaining = Math.max(0, tokenLimit - countTokens(task));
  const context: string[] = [];
  for (
    let index = (taskEvent ? events.indexOf(taskEvent) : events.length) - 1;
    index >= 0;
    index -= 1
  ) {
    const event = events[index];
    if (!event || !event.text || event.role === "tool") continue;
    const value = `${event.role}: ${event.text}`;
    const retained = truncateText(value, remaining, "end");
    if (!retained) break;
    context.unshift(retained);
    remaining -= countTokens(retained);
  }
  const combined = [...context, task].filter(Boolean).join("\n");
  const stateLatestUserIndex = lastEventIndex(stateEvents, "user");
  const logicalEvents =
    stateLatestUserIndex >= 0 ? stateEvents.slice(0, stateLatestUserIndex + 1) : stateEvents;
  return {
    task: combined,
    logicalTurn: logicalEvents.map((event) => `${event.role}:${event.text}`).join("\n"),
    continuation:
      stateLatestUserIndex >= 0 &&
      stateEvents.slice(stateLatestUserIndex + 1).some((event) => event.role !== "system"),
    events,
    tokenCount: countTokens(combined),
  };
}

function conversationEvents(
  input: unknown,
  removeNonUsefulMessages: boolean,
): ModelContextEvent[] {
  if (typeof input === "string") return input.trim() ? [{ role: "user", text: input.trim() }] : [];
  if (Array.isArray(input)) {
    return input.flatMap((value) => messageEvent(value, removeNonUsefulMessages));
  }
  if (!isRecord(input)) return [];
  for (const key of ["messages", "input"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return [{ role: "user", text: value.trim() }];
    if (Array.isArray(value)) {
      const events = value.flatMap((item) => messageEvent(item, removeNonUsefulMessages));
      if (events.length > 0) return events;
    }
  }
  return [];
}

function messageEvent(value: unknown, removeNonUsefulMessages: boolean): ModelContextEvent[] {
  if (typeof value === "string") return value.trim() ? [{ role: "user", text: value.trim() }] : [];
  if (!isRecord(value)) return [];
  const role = messageRole(value);
  if (!role || (removeNonUsefulMessages && role === "tool")) return [];
  if (removeNonUsefulMessages && (value.type === "function_call" || value.type === "reasoning")) {
    return [];
  }
  const text = contentText(value.content ?? value.text ?? value.input_text ?? value.output_text);
  return text ? [{ role, text }] : [];
}

function messageRole(
  value: Readonly<Record<string, unknown>>,
): ModelContextEvent["role"] | undefined {
  if (value.role === "user" || value.role === "assistant" || value.role === "system") {
    return value.role;
  }
  if (
    value.role === "tool" ||
    value.type === "function_call_output" ||
    value.type === "tool_result"
  ) {
    return "tool";
  }
  if (value.type === "function_call" || value.type === "reasoning") return "assistant";
  if (value.type === "message" && value.role === undefined) return "user";
  return undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";
  for (const key of ["text", "input_text", "output_text", "content"] as const) {
    const text = contentText(value[key]);
    if (text) return text;
  }
  return "";
}

const TASK_KEYS = [
  "prompt",
  "task",
  "query",
  "question",
  "request",
  "description",
  "message",
  "text",
  "input",
] as const;
const IGNORED_KEYS = new Set([
  "api_key",
  "authorization",
  "arguments",
  "credentials",
  "headers",
  "metadata",
  "password",
  "provider_options",
  "raw_input",
  "secret",
  "token",
  "tool_calls",
  "tools",
]);

function collectTaskStrings(input: unknown): string[] {
  if (typeof input === "string") return input.trim() ? [input.trim()] : [];
  const preferred: string[] = [];
  if (isRecord(input)) {
    for (const key of TASK_KEYS) preferred.push(...stringLeaves(input[key], key, 0));
  }
  return preferred.length > 0 ? preferred.slice(0, 32) : stringLeaves(input, "", 0).slice(0, 32);
}

function stringLeaves(value: unknown, key: string, depth: number): string[] {
  if (depth > 6 || IGNORED_KEYS.has(key.toLowerCase())) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((item) => stringLeaves(item, key, depth + 1));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([childKey, child]) =>
    stringLeaves(child, childKey, depth + 1),
  );
}

function parseJsonString(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return input;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return input;
  }
}

function countTokens(text: string): number {
  return CONTEXT_ENCODING.encode(text, [], []).length;
}

function truncateText(text: string, tokenLimit: number, edge: "start" | "end"): string {
  if (tokenLimit <= 0 || !text) return "";
  const tokens = CONTEXT_ENCODING.encode(text, [], []);
  if (tokens.length <= tokenLimit) return text;
  return CONTEXT_ENCODING.decode(
    edge === "start" ? tokens.slice(0, tokenLimit) : tokens.slice(-tokenLimit),
  );
}

function lastEventIndex(
  events: readonly ModelContextEvent[],
  role: ModelContextEvent["role"],
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.role === role) return index;
  }
  return -1;
}
