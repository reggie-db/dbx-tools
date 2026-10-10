/**
 * Official Mastra AI SDK chat routes for browser-compatible UI streams.
 *
 * @module
 */

import { errorUtils, log } from "@dbx-tools/shared-core";
import { routes } from "@dbx-tools/shared-mastra";
import {
  isStaleMastraResumeError,
  STALE_MASTRA_RESUME_STREAM_TEXT,
} from "@dbx-tools/shared-mastra/resume";
import { handleChatStream, toAISdkStream } from "@mastra/ai-sdk";
import { isEventedAgent } from "@mastra/core/agent/durable";
import { registerApiRoute } from "@mastra/core/server";
import { createUIMessageStreamResponse } from "ai";

const logger = log.logger("mastra/chat");

/** Client request cancellation is detached only for evented background agents. */
export function agentAbortSignal(agent: unknown, signal: AbortSignal): AbortSignal | undefined {
  return isEventedAgent(agent) ? undefined : signal;
}

/** Register detached chat, durable observation, and explicit abort routes. */
export function agentChatRoutes() {
  const chatPath = `${routes.MASTRA_ROUTES.chat}/:agentId` as `${string}:agentId`;
  const runPath =
    `${routes.MASTRA_ROUTES.chat}/:agentId${routes.MASTRA_ROUTES.runs}/:runId` as `${string}:agentId${string}:runId`;
  const abortPath =
    `${runPath}${routes.MASTRA_ROUTES.abort}` as `${string}:agentId${string}:runId${string}`;
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
        const stream = await handleChatStream({
          mastra,
          agentId,
          ...(versionId
            ? { agentVersion: { versionId } }
            : status
              ? { agentVersion: { status } }
              : {}),
          params: {
            ...params,
            requestContext,
            ...(abortSignal ? { abortSignal } : {}),
          },
          version: "v7",
          sendReasoning: true,
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
          version: "v7",
          sendReasoning: true,
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
      error: errorUtils.errorMessage(error),
    });
    return STALE_MASTRA_RESUME_STREAM_TEXT;
  }
  return errorUtils.errorMessage(error);
}
