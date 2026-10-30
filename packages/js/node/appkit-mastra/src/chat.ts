/**
 * Official Mastra AI SDK chat routes for browser-compatible UI streams.
 *
 * @module
 */

import { log, toError, errorMessage, isRecord, sleep } from "@dbx-tools/shared-core";
import {
  MASTRA_ROUTES,
  RESPONSE_COMPLETE_PART_TYPE,
  THREAD_TITLE_PART_TYPE,
  isStaleMastraResumeError,
  STALE_MASTRA_RESUME_STREAM_TEXT,
} from "@dbx-tools/shared-mastra";
import { handleChatStream, toAISdkStream } from "@mastra/ai-sdk";
import type { Agent } from "@mastra/core/agent";
import { isEventedAgent } from "@mastra/core/agent/durable";
import type { EventedAgent } from "@mastra/core/agent/durable";
import type { RequestContext } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import type { DataChunkType, MastraStreamTransform } from "@mastra/core/stream";
import { createUIMessageStreamResponse } from "ai";
import type { UIMessageChunk } from "ai";

import type { MastraPluginConfig } from "./config.ts";
import {
  buildFollowUpSuggestionsTransform,
  FOLLOW_UP_NATIVE_QUESTIONS_KEY,
  FOLLOW_UP_RUN_ID_KEY,
  FOLLOW_UP_USER_TEXT_KEY,
  resolveFollowUpSuggestionsConfig,
} from "./follow-up-suggestions.ts";
import { requestMemoryScope, withRequestMemoryScope } from "./memory.ts";
import { titleModel, TITLE_INSTRUCTIONS } from "./summarize.ts";
import { activeChatTracingOptions } from "./telemetry.ts";

const logger = log.logger("mastra/chat");

/** Keep a quiet chat stream below the Databricks Apps ingress idle window. */
export const CHAT_STREAM_KEEPALIVE_MS = 10_000;

/** Bound reconnects to producerless durable-run topics before ingress times out. */
export const CHAT_RUN_OBSERVE_IDLE_TIMEOUT_MS = 15_000;

/** Maximum age for a persisted `running` snapshot without a local producer. */
const CHAT_REMOTE_RUN_FRESHNESS_MS = 60_000;

const chatStreamHeartbeat = (): UIMessageChunk => ({
  type: "data-stream-heartbeat",
  data: null,
  transient: true,
});

/** Mark the answer complete while post-turn processors continue before finish. */
export function buildResponseCompleteTransform(): MastraStreamTransform {
  return () => {
    let emitted = false;
    return new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (
          !emitted &&
          chunk.type === "step-finish" &&
          chunk.payload.stepResult.isContinued !== true &&
          (chunk.payload.output.toolCalls?.length ?? 0) === 0
        ) {
          emitted = true;
          const part: DataChunkType = {
            type: RESPONSE_COMPLETE_PART_TYPE,
            data: null,
            transient: true,
          };
          controller.enqueue(part as never);
        }
      },
    });
  };
}

function chatStreamTransforms(
  runId: string,
  generatedFollowUps: boolean,
  titleSettled?: Promise<string | undefined>,
): readonly MastraStreamTransform[] {
  return [
    buildResponseCompleteTransform(),
    ...(generatedFollowUps ? [buildFollowUpSuggestionsTransform(runId)] : []),
    ...(titleSettled ? [buildThreadTitleTransform(titleSettled)] : []),
  ];
}

type ThreadTitleAgent = Pick<Agent, "generateTitleFromUserMessage" | "getMemory">;

/** Start one title generation and persistence future for a new thread. */
export function startThreadTitle(options: {
  agent: ThreadTitleAgent;
  config: MastraPluginConfig;
  requestContext: RequestContext;
  userText: string | undefined;
}): Promise<string | undefined> {
  const { agent, config, requestContext, userText } = options;
  const scope = requestMemoryScope(requestContext);
  if (!scope || !userText) return Promise.resolve(undefined);

  return (async () => {
    const memory = await agent.getMemory({ requestContext });
    if (!memory) return undefined;
    const existing = await memory.getThreadById({ threadId: scope.thread });
    if (existing?.title?.trim()) return undefined;

    const title = (
      await agent.generateTitleFromUserMessage({
        message: userText,
        requestContext,
        model: titleModel(config),
        instructions: TITLE_INSTRUCTIONS,
      })
    )?.trim();
    if (!title) return undefined;

    const current = await memory.getThreadById({ threadId: scope.thread });
    if (current?.title?.trim()) return undefined;
    if (current) {
      await memory.updateThread({ id: scope.thread, title });
      return title;
    }
    await memory.createThread({
      threadId: scope.thread,
      resourceId: scope.resource,
      title,
    });
    return title;
  })().catch((error) => {
    logger.warn("thread title generation failed", { error: toError(error) });
    return undefined;
  });
}

/** Hold the terminal finish until the shared title future has persisted. */
export function buildThreadTitleTransform(
  titleSettled: Promise<string | undefined>,
): MastraStreamTransform {
  return () =>
    new TransformStream({
      async transform(chunk, controller) {
        if (chunk.type === "finish") {
          const title = await titleSettled;
          if (title) {
            const part: DataChunkType = {
              type: THREAD_TITLE_PART_TYPE,
              data: { title },
              transient: true,
            };
            controller.enqueue(part as never);
          }
        }
        controller.enqueue(chunk);
      },
    });
}

function deferredChatStream(open: () => Promise<ReadableStream<UIMessageChunk>>): Response {
  let reader: ReadableStreamDefaultReader<UIMessageChunk> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let settled = false;

  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      const writeHeartbeat = () => {
        if (!settled) controller.enqueue(chatStreamHeartbeat());
      };
      writeHeartbeat();
      timer = setInterval(writeHeartbeat, CHAT_STREAM_KEEPALIVE_MS);
      timer.unref?.();

      void (async () => {
        try {
          const opened = await open();
          if (settled) {
            await opened.cancel();
            return;
          }
          reader = opened.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch (error) {
          if (!settled) {
            controller.enqueue({ type: "error", errorText: errorMessage(error) });
          }
        } finally {
          const shouldClose = !settled;
          settled = true;
          if (timer) clearInterval(timer);
          reader?.releaseLock();
          if (shouldClose) controller.close();
        }
      })();
    },
    async cancel(reason) {
      settled = true;
      if (timer) clearInterval(timer);
      await reader?.cancel(reason);
    },
  });
  return createUIMessageStreamResponse({
    stream,
    keepAliveMs: CHAT_STREAM_KEEPALIVE_MS,
  });
}

async function backgroundRunAvailable(agent: EventedAgent, runId: string): Promise<boolean> {
  if (agent.runRegistry.has(runId)) return true;
  const active = await agent.listActiveRuns();
  const run = active.runs.find((candidate) => candidate.runId === runId);
  if (!run) return false;
  const updatedAt =
    run.updatedAt instanceof Date ? run.updatedAt.getTime() : Date.parse(String(run.updatedAt));
  return Number.isFinite(updatedAt) && Date.now() - updatedAt <= CHAT_REMOTE_RUN_FRESHNESS_MS;
}

async function observeBackgroundRun(agent: EventedAgent, runId: string) {
  const available = await Promise.race([
    backgroundRunAvailable(agent, runId),
    sleep(CHAT_RUN_OBSERVE_IDLE_TIMEOUT_MS).then(() => false),
  ]);
  if (!available) throw new Error(`Run ${runId} is no longer available`);

  const pending = agent.observe(runId, {
    idleTimeoutMs: CHAT_RUN_OBSERVE_IDLE_TIMEOUT_MS,
    isAlive: () =>
      Promise.race([
        backgroundRunAvailable(agent, runId),
        sleep(CHAT_RUN_OBSERVE_IDLE_TIMEOUT_MS).then(() => false),
      ]),
  });
  return Promise.race([
    pending,
    sleep(CHAT_RUN_OBSERVE_IDLE_TIMEOUT_MS).then(() => {
      throw new Error(`Run ${runId} is no longer available`);
    }),
  ]);
}

/** Client request cancellation is detached only for evented background agents. */
export function agentAbortSignal(agent: unknown, signal: AbortSignal): AbortSignal | undefined {
  return isEventedAgent(agent) ? undefined : signal;
}

function latestUserText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const message = value[index];
    if (!isRecord(message) || message.role !== "user") continue;
    if (typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
    if (!Array.isArray(message.parts)) continue;
    const text = message.parts
      .flatMap((part) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
      )
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}

/** Register detached chat, durable observation, and explicit abort routes. */
export function agentChatRoutes(config: MastraPluginConfig = {}) {
  const followUps = resolveFollowUpSuggestionsConfig(config.followUpSuggestions);
  const sendReasoning = config.sendReasoning !== false;
  const chatPath = `${MASTRA_ROUTES.chat}/:agentId` as `${string}:agentId`;
  const runPath =
    `${MASTRA_ROUTES.chat}/:agentId${MASTRA_ROUTES.runs}/:runId` as `${string}:agentId${string}:runId`;
  const abortPath =
    `${runPath}${MASTRA_ROUTES.abort}` as `${string}:agentId${string}:runId${string}`;
  return [
    registerApiRoute(chatPath, {
      method: "POST",
      handler: async (context) => {
        const params = await context.req.json();
        const mastra = context.get("mastra");
        const agentId = context.req.param("agentId");
        if (!agentId) throw new Error("Agent ID is required");
        const middlewareRequestContext = context.get("requestContext");
        const requestContext = middlewareRequestContext || params.requestContext;
        if (middlewareRequestContext && params.requestContext) {
          mastra
            .getLogger()
            ?.warn('Multiple "requestContext" sources provided. Using middleware context.');
        }
        const versionId = context.req.query("versionId");
        const rawStatus = context.req.query("status");
        if (versionId && rawStatus) {
          throw new Error('Query parameters "versionId" and "status" are mutually exclusive');
        }
        if (rawStatus && rawStatus !== "draft" && rawStatus !== "published") {
          throw new Error('Query parameter "status" must be "draft" or "published"');
        }
        const status = rawStatus as "draft" | "published" | undefined;
        const agent = mastra.getAgentById(agentId);
        const abortSignal = agentAbortSignal(agent, context.req.raw.signal);
        const runId =
          typeof params.runId === "string" && params.runId ? params.runId : crypto.randomUUID();
        const userText = latestUserText(params.messages);
        if (userText) requestContext.setRaw(FOLLOW_UP_USER_TEXT_KEY, userText);
        requestContext.setRaw(FOLLOW_UP_NATIVE_QUESTIONS_KEY, []);
        requestContext.setRaw(FOLLOW_UP_RUN_ID_KEY, runId);
        const titleSettled = startThreadTitle({ agent, config, requestContext, userText });
        const tracingOptions = activeChatTracingOptions(undefined);
        return deferredChatStream(async () => {
          return handleChatStream({
            mastra,
            agentId,
            ...(versionId
              ? { agentVersion: { versionId } }
              : status
                ? { agentVersion: { status } }
                : {}),
            params: withRequestMemoryScope(
              {
                ...params,
                runId,
                requestContext,
                ...(tracingOptions ? { tracingOptions } : {}),
                ...(abortSignal ? { abortSignal } : {}),
              },
              requestContext,
            ),
            experimentalTransform: chatStreamTransforms(
              runId,
              Boolean(followUps && followUps.mode !== "genie"),
              titleSettled,
            ),
            version: "v7",
            sendReasoning,
            sendSources: true,
            onError: serializeChatStreamError,
          });
        });
      },
    }),
    registerApiRoute(runPath, {
      method: "GET",
      handler: async (context) => {
        const mastra = context.get("mastra");
        const agentId = context.req.param("agentId");
        const runId = context.req.param("runId");
        if (!agentId || !runId) throw new Error("Agent ID and run ID are required");
        const agent = mastra.getAgentById(agentId);
        if (!isEventedAgent(agent)) {
          return Response.json(
            { error: `Agent ${agentId} does not support background turns` },
            { status: 409 },
          );
        }
        return deferredChatStream(async () => {
          const observed = await observeBackgroundRun(agent, runId);
          return toAISdkStream(observed.output, {
            from: "agent",
            experimentalTransform: chatStreamTransforms(
              runId,
              Boolean(followUps && followUps.mode !== "genie"),
            ),
            version: "v7",
            sendReasoning,
            sendSources: true,
            onError: serializeChatStreamError,
          });
        });
      },
    }),
    registerApiRoute(abortPath, {
      method: "POST",
      handler: async (context) => {
        const mastra = context.get("mastra");
        const agentId = context.req.param("agentId");
        const runId = context.req.param("runId");
        if (!agentId || !runId) throw new Error("Agent ID and run ID are required");
        const agent = mastra.getAgentById(agentId);
        if (!isEventedAgent(agent)) {
          return Response.json(
            { error: `Agent ${agentId} does not support background turns` },
            { status: 409 },
          );
        }
        return Response.json({ aborted: agent.abortRunStream(runId) });
      },
    }),
  ];
}

/**
 * Keep a late or duplicate resume from failing the UI stream. Mastra's
 * resume path can surface a workflow error after another client already
 * resolved the same approval.
 */
function serializeChatStreamError(error: unknown): string {
  if (isStaleMastraResumeError(error)) {
    logger.warn("ignored stale mastra resume", {
      error: toError(error),
    });
    return STALE_MASTRA_RESUME_STREAM_TEXT;
  }
  return errorMessage(error);
}
