/**
 * ChatFast post-turn follow-up suggestion generation.
 *
 * @module
 */

import { asyncUtils, errorUtils, log, stringUtils } from "@dbx-tools/shared-core";
import {
  FOLLOW_UP_SUGGESTIONS_PART_TYPE,
  type FollowUpSuggestionsPartData,
  FollowUpSuggestionsPartDataSchema,
} from "@dbx-tools/shared-mastra/wire";
import { model } from "@dbx-tools/shared-model";
import { Agent } from "@mastra/core/agent";
import type { MessageList } from "@mastra/core/agent/message-list";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { OutputProcessor } from "@mastra/core/processors";
import type { RequestContext } from "@mastra/core/request-context";
import type { DataChunkType, MastraStreamTransform } from "@mastra/core/stream";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import type { FollowUpSuggestionsConfig, MastraPluginConfig } from "./config.ts";
import { buildModel } from "./model.ts";
import { TYPOGRAPHY_RULE } from "./style.ts";

const logger = log.logger("mastra/follow-up-suggestions");
const FOLLOW_UP_MODEL_CLASS = model.ModelClass.ChatFast;
const DEFAULT_QUESTION_LIMIT = 3;
const MAX_QUESTION_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
const GENERIC_QUESTIONS = new Set([
  "anything else",
  "can you tell me more",
  "tell me more",
  "what else",
  "what would you like to know",
]);

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
  nativeQuestions?: readonly string[];
  requestContext?: RequestContext;
  abortSignal?: AbortSignal;
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
    nativeQuestions: z
      .array(z.string().trim().min(1))
      .optional()
      .describe("Existing follow-up questions to avoid repeating."),
  })
  .strict();

const FOLLOW_UP_INSTRUCTIONS = [
  "Generate concise follow-up questions for a completed assistant turn.",
  "Every question must be answerable from the same tools and data domain as the completed turn.",
  "Prefer concrete next analyses, comparisons, filters, or explanations.",
  "Do not repeat the user's question, the answer, or an existing suggestion.",
  "Do not ask generic filler such as 'Anything else?' or request unsupported data.",
  "Return zero questions when no useful grounded follow-up exists.",
  TYPOGRAPHY_RULE,
].join(" ");

const suggestionAgents = new WeakMap<MastraPluginConfig, Agent>();
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

function followUpModel(
  config: MastraPluginConfig,
): (args: { requestContext: RequestContext }) => Promise<MastraModelConfig> {
  return ({ requestContext }) =>
    buildModel(config, requestContext, { modelClass: FOLLOW_UP_MODEL_CLASS });
}

function suggestionAgent(config: MastraPluginConfig): Agent {
  let agent = suggestionAgents.get(config);
  if (!agent) {
    agent = new Agent({
      id: "follow-up-suggestions",
      name: "Follow-up suggestions",
      description: "Generates grounded next questions using the fast chat model.",
      instructions: FOLLOW_UP_INSTRUCTIONS,
      model: followUpModel(config),
    });
    suggestionAgents.set(config, agent);
  }
  return agent;
}

function normalizedQuestion(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}

function acceptedQuestions(
  questions: readonly string[],
  options: SuggestFollowUpsOptions,
  maxQuestions: number,
): string[] {
  const excluded = new Set([
    normalizedQuestion(options.userText),
    ...(options.nativeQuestions ?? []).map(normalizedQuestion),
  ]);
  const accepted: string[] = [];
  for (const question of questions) {
    const trimmed = question.trim();
    const normalized = normalizedQuestion(trimmed);
    if (
      !normalized ||
      normalized.length < 8 ||
      excluded.has(normalized) ||
      GENERIC_QUESTIONS.has(normalized)
    ) {
      continue;
    }
    excluded.add(normalized);
    accepted.push(trimmed);
    if (accepted.length >= maxQuestions) break;
  }
  return accepted;
}

/** Generate grounded follow-ups through ChatFast, failing open to an empty list. */
export async function suggestFollowUps(
  config: MastraPluginConfig,
  options: SuggestFollowUpsOptions,
): Promise<string[]> {
  const settings = resolveFollowUpSuggestionsConfig(config.followUpSuggestions);
  if (!settings || settings.mode === "genie") return [];
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  const abortSignal = asyncUtils.combineAbortSignals(options.abortSignal, timeout);
  const prompt = stringUtils.toDescription({
    "User message": options.userText,
    "Assistant answer": options.answer,
    ...(options.nativeQuestions?.length
      ? { "Existing suggestions": JSON.stringify(options.nativeQuestions) }
      : {}),
    "Maximum questions": String(settings.limit),
  });
  try {
    const result = await suggestionAgent(config).generate(prompt, {
      structuredOutput: { schema: FollowUpOutputSchema },
      ...(options.requestContext ? { requestContext: options.requestContext } : {}),
      abortSignal,
    });
    const parsed = FollowUpOutputSchema.parse(result.object);
    return acceptedQuestions(parsed.questions, options, settings.limit);
  } catch (error) {
    if (!options.abortSignal?.aborted) {
      logger.warn("generation-failed", { error: errorUtils.errorMessage(error) });
    }
    return [];
  }
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
      const questions = await suggester(config, {
        userText,
        answer,
        ...(nativeQuestions.length > 0 ? { nativeQuestions } : {}),
        requestContext,
        ...(abortSignal ? { abortSignal } : {}),
      });
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
        ...(values.nativeQuestions ? { nativeQuestions: values.nativeQuestions } : {}),
        ...(context?.requestContext ? { requestContext: context.requestContext } : {}),
        ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
      });
      return { questions };
    },
  });
}
