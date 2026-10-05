/**
 * Authenticated streaming transport for direct Databricks gateway routes.
 *
 * @module
 */

import { getExecutionContext } from "@databricks/appkit";
import { workspaceClient } from "@dbx-tools/databricks";
import { invoke } from "@dbx-tools/model";
import { log } from "@dbx-tools/shared-core";
import type { GatewayRoute } from "@dbx-tools/shared-model-gateway";

const logger = log.logger("appkit/model-gateway/transport");
const ERROR_PREVIEW_BYTES = 8 * 1024;

const BLOCKED_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "transfer-encoding",
  "x-api-key",
]);

const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Inputs for one direct Databricks protocol request. */
export interface DatabricksTransportRequest {
  readonly route: GatewayRoute;
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers: Headers;
  readonly signal: AbortSignal;
}

/** Execute a direct route with SDK-owned authentication and an unbuffered response body. */
export async function fetchDatabricks(request: DatabricksTransportRequest): Promise<Response> {
  const client = getExecutionContext().client;
  const host = (await client.config.getHost()).toString();
  const headers = new Headers({ "content-type": "application/json" });
  request.headers.forEach((value, name) => {
    const normalized = name.toLowerCase();
    if (!BLOCKED_REQUEST_HEADERS.has(normalized) && !normalized.startsWith("x-forwarded-")) {
      headers.set(name, value);
    }
  });
  await client.config.authenticate(headers);
  const url = upstreamUrl(host, request.route);
  const startedAt = Date.now();
  const body = JSON.stringify({ ...request.body, model: request.route.upstreamModel });
  logger.debug("sending upstream request", {
    model: request.route.upstreamModel,
    path: new URL(url).pathname,
    stream: request.body.stream === true,
    upstreamProtocol: request.route.upstreamProtocol,
  });
  try {
    let response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: request.signal,
    });
    if (
      response.status === 401 &&
      (await workspaceClient.refreshWorkspaceClientAuthentication(client))
    ) {
      logger.debug("retrying rejected upstream credential", {
        model: request.route.upstreamModel,
        upstreamProtocol: request.route.upstreamProtocol,
      });
      await response.body?.cancel();
      headers.delete("authorization");
      headers.delete("x-databricks-workspace-id");
      await client.config.authenticate(headers);
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: request.signal,
      });
    }
    const details = {
      elapsedMs: Date.now() - startedAt,
      model: request.route.upstreamModel,
      requestId:
        response.headers.get("x-request-id") ?? response.headers.get("x-databricks-request-id"),
      status: response.status,
      upstreamProtocol: request.route.upstreamProtocol,
    };
    if (response.ok) {
      logger.debug("received upstream response", details);
    } else {
      logger.warn("upstream response failed", details);
      void logUpstreamFailureBody(response.clone(), details);
    }
    return response;
  } catch (error) {
    logger.error("upstream fetch failed", {
      elapsedMs: Date.now() - startedAt,
      error,
      model: request.route.upstreamModel,
      upstreamProtocol: request.route.upstreamProtocol,
    });
    throw error;
  }
}

/** Copy only response headers that belong to the public model protocol. */
export function gatewayResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  upstream.forEach((value, name) => {
    if (!BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  });
  return headers;
}

/** Resolve the exact upstream URL for a deterministic direct route. */
export function upstreamUrl(host: string, route: GatewayRoute): string {
  switch (route.upstreamProtocol) {
    case "databricks-ai-gateway-codex":
      return invoke.aiGatewayCodexResponsesUrl(host);
    case "databricks-responses":
      return invoke.responsesUrl(host);
    case "databricks-open-responses":
      return invoke.openResponsesUrl(host);
    case "databricks-chat":
      return invoke.chatCompletionsUrl(host);
    case "databricks-anthropic":
      return invoke.anthropicMessagesUrl(host);
    case "databricks-embeddings":
      return invoke.invocationsUrl(host, route.upstreamModel);
    case "ai-sdk":
      throw new Error("AI SDK routes do not use the direct Databricks transport");
  }
}

async function logUpstreamFailureBody(
  response: Response,
  details: Record<string, unknown>,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let preview = "";
  let bytes = 0;
  try {
    while (bytes < ERROR_PREVIEW_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = ERROR_PREVIEW_BYTES - bytes;
      const value = chunk.value.subarray(0, remaining);
      bytes += value.byteLength;
      preview += decoder.decode(value, { stream: true });
      if (value.byteLength < chunk.value.byteLength) break;
    }
    preview += decoder.decode();
    logger.warn("upstream error body", {
      ...details,
      preview,
      truncated: bytes >= ERROR_PREVIEW_BYTES,
    });
  } catch (error) {
    logger.debug("could not read upstream error body", { ...details, error });
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
