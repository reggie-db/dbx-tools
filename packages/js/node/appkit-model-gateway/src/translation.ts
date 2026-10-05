/**
 * Vercel AI SDK fallback translation between external gateway protocols.
 *
 * @module
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenResponses } from "@ai-sdk/open-responses";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getExecutionContext } from "@databricks/appkit";
import { invoke, servingWire } from "@dbx-tools/model";
import { log } from "@dbx-tools/shared-core";
import type { GatewayRoute } from "@dbx-tools/shared-model-gateway";
import { streamText, type LanguageModel, type ToolSet } from "ai";

import { decodeGatewayRequest } from "./protocols/decode.ts";
import { encodeGatewayResponse, encodeGatewayStream } from "./protocols/encode.ts";

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
  if (route.target.capabilities.responses) {
    logger.debug("selected Responses provider", { model: route.target.id });
    return createOpenResponses({
      name: "databricks-responses",
      url: invoke.responsesUrl(host),
      headers,
    })(route.target.id);
  }
  if (route.target.capabilities.anthropic) {
    logger.debug("selected Anthropic provider", { model: route.target.id });
    return createAnthropic({
      name: "databricks-anthropic",
      baseURL: new URL("serving-endpoints/anthropic/v1", host).toString(),
      authToken: bearerToken(headers),
      headers,
    })(route.target.id);
  }
  logger.debug("selected Chat provider", { model: route.target.id });
  return createOpenAICompatible({
    name: "databricks-chat",
    baseURL: new URL("serving-endpoints", host).toString(),
    headers,
    supportsStructuredOutputs: true,
    fetch: compatibleFetch,
  }).chatModel(route.target.id);
}

async function compatibleFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const rewritten = await servingWire.rewriteServingRequest(input, init);
  logger.debug("sending translated Chat request", {
    rewritten: rewritten.input !== input || rewritten.init !== init,
  });
  const response = await fetch(rewritten.input, rewritten.init);
  const responseDetails = {
    contentType: response.headers.get("content-type"),
    status: response.status,
  };
  if (response.ok) logger.debug("received translated Chat response", responseDetails);
  else logger.warn("translated Chat request failed", responseDetails);
  if (!response.body) return response;
  const headers = new Headers(response.headers);
  if (headers.get("content-type")?.includes("text/event-stream")) {
    return new Response(servingWire.rewriteServingResponseStream(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const body = servingWire.rewriteServingResponseBody(await response.text());
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function bearerToken(headers: Readonly<Record<string, string>>): string {
  const authorization = headers.authorization ?? headers.Authorization;
  const [scheme, token] = authorization?.split(/\s+/, 2) ?? [];
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    throw new Error("Databricks authentication did not produce a bearer token");
  }
  return token;
}
