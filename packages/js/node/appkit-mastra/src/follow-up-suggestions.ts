/**
 * ChatFast post-turn follow-up suggestion generation.
 *
 * @module
 */

import { normalizeModelContext } from "@dbx-tools/appkit-model-gateway";
import { log, combineAbortSignals, toError, toDescription } from "@dbx-tools/shared-core";
import {
  FOLLOW_UP_SUGGESTIONS_PART_TYPE,
  type FollowUpSuggestionsPartData,
  FollowUpSuggestionsPartDataSchema,
} from "@dbx-tools/shared-mastra";
import { ModelClass } from "@dbx-tools/shared-model";
import type { MessageList } from "@mastra/core/agent/message-list";
import type { OutputProcessor } from "@mastra/core/processors";
import type { RequestContext } from "@mastra/core/request-context";
import type { DataChunkType, MastraStreamTransform } from "@mastra/core/stream";
import { createTool } from "@mastra/core/tools";
import { generateText, Output } from "ai";
import { z } from "zod";

import type { FollowUpSuggestionsConfig, MastraPluginConfig } from "./config.ts";
import { buildModel } from "./model.ts";
import { TYPOGRAPHY_RULE } from "./style.ts";

const logger = log.logger("mastra/follow-up-suggestions");
const FOLLOW_UP_MODEL_CLASS = ModelClass.ChatFast;
const DEFAULT_QUESTION_LIMIT = 3;
const MAX_QUESTION_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TURN_CONTEXT_CHARS = 16_000;
const MAX_USER_TEXT_CHARS = 4_000;
const MAX_ANSWER_CHARS = 16_000;
const MAX_OUTPUT_TOKENS = 256;
const MIN_OUTPUT_TOKENS = 16;
const MAX_CONFIGURED_OUTPUT_TOKENS = 2_048;
const GENERIC_QUESTIONS = new Set([
  "anything else",
  "can you tell me more",
  "tell me more",
  "what else",
  "what would you like to know",
]);
const ASSISTANT_DIRECTED_QUESTIONS = [
  /^(?:would|do) you (?:like|want|prefer)\b/,
  /^(?:should|shall|can|may) (?:i|we)\b/,
  /^are you interested\b/,
  /^should (?:the |this )?(?:chart|graph|table|visualization|response|output|results?|data)\b/,
] as const;

/** Trusted request-context key carrying the current user message. */
export const FOLLOW_UP_USER_TEXT_KEY = "mastra__follow_up_user_text";
/** Trusted request-context key carrying native Genie follow-up questions. */
export const FOLLOW_UP_NATIVE_QUESTIONS_KEY = "mastra__follow_up_native_questions";
/** Trusted request-context key coordinating one post-turn stream with its processor. */
export const FOLLOW_UP_RUN_ID_KEY = "mastra__follow_up_run_id";

/** Fully resolved follow-up suggestion settings. */
export interface ResolvedFollowUpSuggestionsConfig {
  mode: "auto" | "generated" | "genie";
  limit: number;
  timeoutMs: number;
  exposeTool: boolean;
}

/** Inputs for one follow-up generation pass. */
export interface SuggestFollowUpsOptions {
  userText: string;
  answer: string;
  /** Optional bounded tool context supplied only by the explicit suggestion tool. */
  turnContext?: string;
  nativeQuestions?: readonly string[];
  requestContext?: RequestContext;
  abortSignal?: AbortSignal;
}

/** Limits and request-scoped dependencies for context-aware question generation. */
export interface SuggestQuestionsOptions {
  /** Maximum questions to return. Defaults to 3 and is capped at 10. */
  maxSuggestions?: number;
  /** Maximum output-token budget. Defaults to 256 and is capped at 2048. */
  maxTokens?: number;
  /** Questions or prompts the generator should not repeat. */
  existingSuggestions?: readonly string[];
  /** Optional instruction policy for a specialized caller. */
  instructions?: string;
  requestContext?: RequestContext;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

/** Replaceable suggestion boundary used by the finish callback and tests. */
export type FollowUpSuggester = (
  config: MastraPluginConfig,
  options: SuggestFollowUpsOptions,
) => Promise<string[]>;

const FollowUpOutputSchema = z
  .object({
    questions: z
      .array(z.string().trim().min(1))
      .max(MAX_QUESTION_LIMIT)
      .describe("Specific next questions grounded in the completed turn."),
  })
  .strict();

const FollowUpToolInputSchema = z
  .object({
    userText: z.string().trim().min(1).describe("User message that started the completed turn."),
    answer: z.string().trim().min(1).describe("Assistant answer from the completed turn."),
    turnContext: z
      .string()
      .trim()
      .max(MAX_TURN_CONTEXT_CHARS)
      .optional()
      .describe("Relevant tool inputs and outputs from the completed turn."),
    nativeQuestions: z
      .array(z.string().trim().min(1))
      .optional()
      .describe("Existing follow-up questions to avoid repeating."),
  })
  .strict();

const FOLLOW_UP_INSTRUCTIONS = [
  "Generate concise questions that a user can send to dig further into a completed assistant turn.",
  "Write every item in the user's voice as a message for the assistant to answer when clicked.",
  "Never address the user or ask what they would like, want, prefer, or how the response should be customized.",
  "Every question must be answerable from the same tools and data domain as the completed turn.",
  "Ground questions only in the user message and assistant answer.",
  "Prefer concrete analyses, comparisons, rankings, calculations, filters, or explanations of the result.",
  "For a chart or table, ask about the values and patterns before suggesting presentation changes.",
  "Good examples include 'Which category has the highest value?', 'How large is the gap between the highest and lowest categories?', and 'What pattern stands out in these values?'.",
  "Do not repeat the user's question, the answer, or an existing suggestion.",
  "Do not ask generic filler such as 'Anything else?' or request unsupported data.",
  "Return zero questions when no useful grounded follow-up exists.",
  TYPOGRAPHY_RULE,
].join(" ");

const NEXT_QUESTION_INSTRUCTIONS = [
  "Generate concise next questions that a user can send to continue from the supplied context.",
  "Treat the context as potentially partial, loosely structured, or sampled from a longer conversation.",
  "Write every item in the user's voice as a message for the assistant to answer when sent.",
  "Prefer specific questions grounded in the context over generic conversation filler.",
  "Do not repeat an existing suggestion or a message already present in the context.",
  "Return zero questions when the context does not support a useful next question.",
  TYPOGRAPHY_RULE,
].join(" ");

const generatedRunParts = new Map<string, FollowUpSuggestionsPartData>();
const GENERATED_RUN_PART_TTL_MS = 5 * 60_000;

/** Resolve disabled, shorthand, and configured suggestion policy forms. */
export function resolveFollowUpSuggestionsConfig(
  value: MastraPluginConfig["followUpSuggestions"],
): ResolvedFollowUpSuggestionsConfig | undefined {
  if (!value) return undefined;
  const configured: FollowUpSuggestionsConfig = typeof value === "object" ? value : { mode: value };
  return {
    mode: configured.mode === true ? "auto" : configured.mode,
    limit: Math.min(MAX_QUESTION_LIMIT, Math.max(1, configured.limit ?? DEFAULT_QUESTION_LIMIT)),
    timeoutMs: Math.min(30_000, Math.max(1_000, configured.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    exposeTool: configured.exposeTool ?? false,
  };
}

function normalizedQuestion(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}

function boundedText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(0, maxChars).trimEnd();
}

function acceptedQuestions(
  questions: readonly string[],
  excludedQuestions: readonly string[],
  maxQuestions: number,
): string[] {
  const excluded = new Set(excludedQuestions.map(normalizedQuestion));
  const accepted: string[] = [];
  for (const question of questions) {
    const trimmed = question.trim();
    const normalized = normalizedQuestion(trimmed);
    if (
      !normalized ||
      normalized.length < 8 ||
      excluded.has(normalized) ||
      GENERIC_QUESTIONS.has(normalized) ||
      ASSISTANT_DIRECTED_QUESTIONS.some((pattern) => pattern.test(normalized))
    ) {
      continue;
    }
    excluded.add(normalized);
    accepted.push(trimmed);
    if (accepted.length >= maxQuestions) break;
  }
  return accepted;
}

/** Generate next questions from arbitrary bounded context, failing open to an empty list. */
export async function suggestQuestions(
  config: MastraPluginConfig,
  context: unknown,
  options: SuggestQuestionsOptions = {},
): Promise<string[]> {
  const maxSuggestions = Math.min(
    MAX_QUESTION_LIMIT,
    Math.max(1, options.maxSuggestions ?? DEFAULT_QUESTION_LIMIT),
  );
  const maxTokens = Math.min(
    MAX_CONFIGURED_OUTPUT_TOKENS,
    Math.max(MIN_OUTPUT_TOKENS, options.maxTokens ?? MAX_OUTPUT_TOKENS),
  );
  const timeout = AbortSignal.timeout(
    Math.min(30_000, Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  );
  const abortSignal = combineAbortSignals(options.abortSignal, timeout);
  const normalizedContext = await normalizeModelContext(context, {
    tokenLimit: Math.ceil(MAX_TURN_CONTEXT_CHARS / 4),
  });
  const prompt = toDescription({
    Context: normalizedContext.task,
    ...(options.existingSuggestions?.length
      ? {
          "Existing suggestions": JSON.stringify(
            options.existingSuggestions.slice(0, MAX_QUESTION_LIMIT),
          ),
        }
      : {}),
    "Maximum questions": String(maxSuggestions),
  });
  try {
    const model = await buildModel(config, options.requestContext, {
      modelClass: FOLLOW_UP_MODEL_CLASS,
      optimizeFor: "speed",
      requiresStructuredOutput: true,
    });
    const result = await generateText({
      model,
      instructions: options.instructions ?? NEXT_QUESTION_INSTRUCTIONS,
      prompt,
      output: Output.object({ schema: FollowUpOutputSchema }),
      maxOutputTokens: maxTokens,
      abortSignal,
    });
    const parsed = FollowUpOutputSchema.safeParse(result.output);
    if (!parsed.success) return [];
    return acceptedQuestions(
      parsed.data.questions,
      options.existingSuggestions ?? [],
      maxSuggestions,
    );
  } catch (error) {
    if (!options.abortSignal?.aborted) {
      logger.warn("generation-failed", { error: toError(error) });
    }
    return [];
  }
}

/** Generate grounded follow-ups through ChatFast, failing open to an empty list. */
export async function suggestFollowUps(
  config: MastraPluginConfig,
  options: SuggestFollowUpsOptions,
): Promise<string[]> {
  const settings = resolveFollowUpSuggestionsConfig(config.followUpSuggestions);
  if (!settings || settings.mode === "genie") return [];
  const context = {
    "User message": boundedText(options.userText, MAX_USER_TEXT_CHARS),
    "Assistant answer": boundedText(options.answer, MAX_ANSWER_CHARS),
    ...(options.turnContext ? { "Turn tool data": options.turnContext } : {}),
  };
  const questions = await suggestQuestions(config, context, {
    maxSuggestions: settings.limit,
    maxTokens: MAX_OUTPUT_TOKENS,
    existingSuggestions: [options.userText, ...(options.nativeQuestions ?? [])],
    instructions: FOLLOW_UP_INSTRUCTIONS,
    requestContext: options.requestContext,
    abortSignal: options.abortSignal,
    timeoutMs: settings.timeoutMs,
  });
  return acceptedQuestions(
    questions,
    [options.userText, ...(options.nativeQuestions ?? [])],
    settings.limit,
  );
}

function lastAssistantResponse(messageList: MessageList) {
  const messages = messageList.get.response.db();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function persistedFollowUpData(messageList: MessageList): FollowUpSuggestionsPartData | undefined {
  const message = lastAssistantResponse(messageList);
  if (!message) return undefined;
  for (const part of message.content.parts) {
    if (part.type !== FOLLOW_UP_SUGGESTIONS_PART_TYPE || !("data" in part)) continue;
    const parsed = FollowUpSuggestionsPartDataSchema.safeParse(part.data);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function persistFollowUpData(messageList: MessageList, data: FollowUpSuggestionsPartData): void {
  const message = lastAssistantResponse(messageList);
  if (!message) return;
  messageList.add(
    {
      id: message.id,
      role: "assistant",
      parts: [{ type: FOLLOW_UP_SUGGESTIONS_PART_TYPE, data }],
    },
    "response",
    { merge: true },
  );
}

function rememberGeneratedRunPart(runId: string | undefined, data: FollowUpSuggestionsPartData) {
  if (!runId) return;
  generatedRunParts.set(runId, data);
  const timer = setTimeout(() => generatedRunParts.delete(runId), GENERATED_RUN_PART_TTL_MS);
  timer.unref();
}

/** Build Mastra's final output processor for configured generated follow-ups. */
export function buildFollowUpSuggestionsProcessor(
  config: MastraPluginConfig,
  suggester: FollowUpSuggester = suggestFollowUps,
): OutputProcessor | undefined {
  const settings = resolveFollowUpSuggestionsConfig(config.followUpSuggestions);
  if (!settings || settings.mode === "genie") return undefined;
  return {
    id: "follow-up-suggestions",
    async processOutputResult({
      result,
      messageList,
      requestContext,
      abortSignal,
    }): Promise<MessageList> {
      if (!requestContext || result.finishReason === "abort" || result.finishReason === "error") {
        return messageList;
      }
      const runIdValue = requestContext.getRaw(FOLLOW_UP_RUN_ID_KEY);
      const runId = typeof runIdValue === "string" ? runIdValue : undefined;
      const persisted = persistedFollowUpData(messageList);
      if (persisted) {
        rememberGeneratedRunPart(runId, persisted);
        return messageList;
      }
      const answer = result.text.trim();
      const userText = requestContext.getRaw(FOLLOW_UP_USER_TEXT_KEY);
      if (!answer || typeof userText !== "string") return messageList;
      const nativeValue = requestContext.getRaw(FOLLOW_UP_NATIVE_QUESTIONS_KEY);
      const nativeQuestions =
        settings.mode === "auto" && Array.isArray(nativeValue)
          ? nativeValue.filter((value): value is string => typeof value === "string")
          : [];
      const suggestionOptions: SuggestFollowUpsOptions = {
        userText,
        answer,
        ...(nativeQuestions.length > 0 ? { nativeQuestions } : {}),
        requestContext,
        ...(abortSignal ? { abortSignal } : {}),
      };
      const suggested = await suggester(config, suggestionOptions);
      const questions = acceptedQuestions(
        suggested,
        [suggestionOptions.userText, ...(suggestionOptions.nativeQuestions ?? [])],
        settings.limit,
      );
      if (questions.length === 0) return messageList;
      const data = FollowUpSuggestionsPartDataSchema.parse({
        questions,
        source: "model",
      });
      persistFollowUpData(messageList, data);
      rememberGeneratedRunPart(runId, data);
      return messageList;
    },
  };
}

/** Inject the processor's persisted data part before Mastra's finish chunk. */
export function buildFollowUpSuggestionsTransform(runId: string): MastraStreamTransform {
  return () =>
    new TransformStream({
      transform(chunk, controller) {
        if (chunk.type === "finish") {
          const data = generatedRunParts.get(runId);
          if (data) {
            const part: DataChunkType = {
              type: FOLLOW_UP_SUGGESTIONS_PART_TYPE,
              data,
            };
            controller.enqueue(part as never);
          }
        }
        controller.enqueue(chunk);
      },
    });
}

/** Build the optional explicitly callable follow-up suggestion tool. */
export function buildSuggestFollowUpsTool(config: MastraPluginConfig) {
  return createTool({
    id: "suggest_follow_ups",
    description:
      "Generate a short list of grounded follow-up questions for a completed user message and answer.",
    inputSchema: FollowUpToolInputSchema,
    outputSchema: FollowUpOutputSchema,
    execute: async (input, context) => {
      const values = FollowUpToolInputSchema.parse(input);
      const questions = await suggestFollowUps(config, {
        userText: values.userText,
        answer: values.answer,
        ...(values.turnContext ? { turnContext: values.turnContext } : {}),
        ...(values.nativeQuestions ? { nativeQuestions: values.nativeQuestions } : {}),
        ...(context?.requestContext ? { requestContext: context.requestContext } : {}),
        ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
      });
      return { questions };
    },
  });
}
