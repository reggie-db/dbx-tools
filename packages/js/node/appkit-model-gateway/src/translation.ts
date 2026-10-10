/**
 * Vercel AI SDK fallback translation between external gateway protocols.
 *
 * @module
 */

import { getExecutionContext } from "@databricks/appkit";
import { invoke } from "@dbx-tools/model";
import { decodeGatewayRequest } from "@dbx-tools/model-protocol/gateway-decode";
import {
  encodeGatewayResponse,
  encodeGatewayStream,
} from "@dbx-tools/model-protocol/gateway-encode";
import {
  createDatabricksLanguageModel,
  type DatabricksLanguageModelProtocol,
} from "@dbx-tools/model-protocol/provider";
import { log } from "@dbx-tools/shared-core";
import type { GatewayRoute } from "@dbx-tools/shared-model-gateway";
import { streamText, type LanguageModel, type ToolSet } from "ai";

const logger = log.logger("appkit/model-gateway/translation");

/** Translate one request through a provider-owned AI SDK model. */
export async function translateGatewayRequest(
  route: GatewayRoute,
  body: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<Response> {
  const decoded = decodeGatewayRequest(route.clientProtocol, body);
  logger.debug("decoded request", {
    clientProtocol: route.clientProtocol,
    messageCount: decoded.messages.length,
    model: route.target.id,
    stream: body.stream === true,
    toolCount: Object.keys(decoded.tools).length,
  });
  const model = await translationModel(route);
  const result = streamText({
    model,
    messages: decoded.messages,
    allowSystemInMessages: true,
    ...(Object.keys(decoded.tools).length > 0 ? { tools: decoded.tools } : {}),
    ...(decoded.maxOutputTokens !== undefined ? { maxOutputTokens: decoded.maxOutputTokens } : {}),
    ...(decoded.temperature !== undefined ? { temperature: decoded.temperature } : {}),
    ...(decoded.topP !== undefined ? { topP: decoded.topP } : {}),
    maxRetries: 0,
    abortSignal: signal,
    onError: ({ error }) => {
      logger.error("stream failed", { error, model: route.target.id });
    },
    onAbort: () => {
      logger.debug("translation aborted", { model: route.target.id });
    },
    onFinish: ({ finishReason, usage }) => {
      logger.debug("translation finished", {
        finishReason,
        inputTokens: usage.inputTokens,
        model: route.target.id,
        outputTokens: usage.outputTokens,
      });
    },
  });

  if (body.stream === true) {
    logger.debug("returning translated stream", {
      clientProtocol: route.clientProtocol,
      model: route.target.id,
    });
    return new Response(
      encodeGatewayStream(
        route.clientProtocol,
        route.target.id,
        result.stream as AsyncIterable<import("ai").TextStreamPart<ToolSet>>,
      ),
      {
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
          "x-accel-buffering": "no",
        },
      },
    );
  }

  const [text, toolCalls, usage, finishReason] = await Promise.all([
    result.text,
    result.toolCalls,
    result.usage,
    result.finishReason,
  ]);
  logger.debug("returning translated response", {
    clientProtocol: route.clientProtocol,
    finishReason,
    inputTokens: usage.inputTokens,
    model: route.target.id,
    outputTokens: usage.outputTokens,
    toolCallCount: toolCalls.length,
  });
  return Response.json(
    encodeGatewayResponse(route.clientProtocol, route.target.id, {
      text,
      toolCalls: toolCalls as import("ai").TypedToolCall<ToolSet>[],
      usage,
      finishReason,
    }),
  );
}

async function translationModel(route: GatewayRoute): Promise<LanguageModel> {
  const client = getExecutionContext().client;
  const host = (await client.config.getHost()).toString();
  const headers = await invoke.authHeaders(client);
  const protocol = translationProtocol(route);
  logger.debug("selected translation provider", { model: route.target.id, protocol });
  return createDatabricksLanguageModel({
    modelId: route.target.id,
    protocol,
    host,
    headers,
  });
}

function translationProtocol(route: GatewayRoute): DatabricksLanguageModelProtocol {
  if (route.target.capabilities.responses) return "responses";
  if (route.target.capabilities.anthropic) return "anthropic";
  return "chat";
}
