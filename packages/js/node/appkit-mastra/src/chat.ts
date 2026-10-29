/**
 * Official Mastra AI SDK chat routes for browser-compatible UI streams.
 *
 * @module
 */

import { log, toError, errorMessage, isRecord } from "@dbx-tools/shared-core";
import {
  MASTRA_ROUTES,
  isStaleMastraResumeError,
  STALE_MASTRA_RESUME_STREAM_TEXT,
} from "@dbx-tools/shared-mastra";
import { handleChatStream, toAISdkStream } from "@mastra/ai-sdk";
import { isEventedAgent } from "@mastra/core/agent/durable";
import { registerApiRoute } from "@mastra/core/server";
import { createUIMessageStreamResponse } from "ai";

import type { MastraPluginConfig } from "./config.ts";
import {
  buildFollowUpSuggestionsTransform,
  FOLLOW_UP_NATIVE_QUESTIONS_KEY,
  FOLLOW_UP_RUN_ID_KEY,
  FOLLOW_UP_USER_TEXT_KEY,
  resolveFollowUpSuggestionsConfig,
} from "./follow-up-suggestions.ts";
import { withRequestMemoryScope } from "./memory.ts";
import { activeChatTracingOptions } from "./telemetry.ts";

const logger = log.logger("mastra/chat");

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
        const abortSignal = agentAbortSignal(mastra.getAgentById(agentId), context.req.raw.signal);
        const runId =
          typeof params.runId === "string" && params.runId ? params.runId : crypto.randomUUID();
        const userText = latestUserText(params.messages);
        if (userText) requestContext.setRaw(FOLLOW_UP_USER_TEXT_KEY, userText);
        requestContext.setRaw(FOLLOW_UP_NATIVE_QUESTIONS_KEY, []);
        requestContext.setRaw(FOLLOW_UP_RUN_ID_KEY, runId);
        const tracingOptions = activeChatTracingOptions(undefined);
        const stream = await handleChatStream({
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
          ...(followUps && followUps.mode !== "genie"
            ? { experimentalTransform: buildFollowUpSuggestionsTransform(runId) }
            : {}),
          version: "v7",
          sendReasoning,
          sendSources: true,
          onError: serializeChatStreamError,
        });
        return createUIMessageStreamResponse({ stream });
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
        const observed = await agent.observe(runId);
        const stream = toAISdkStream(observed.output, {
          from: "agent",
          ...(followUps && followUps.mode !== "genie"
            ? { experimentalTransform: buildFollowUpSuggestionsTransform(runId) }
            : {}),
          version: "v7",
          sendReasoning,
          sendSources: true,
          onError: serializeChatStreamError,
        });
        return createUIMessageStreamResponse({ stream });
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
