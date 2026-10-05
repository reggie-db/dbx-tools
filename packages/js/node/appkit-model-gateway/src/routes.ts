/**
 * Express adapters for the shared model-gateway service.
 *
 * @module
 */

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { log } from "@dbx-tools/shared-core";
import type { ClientProtocol } from "@dbx-tools/shared-model-gateway";
import type express from "express";

import { ModelGateway, ModelGatewayError } from "./gateway.ts";
import { UnsupportedGatewayFeatureError } from "./router.ts";

const logger = log.logger("appkit/model-gateway/http");

/** Send the lightweight compatibility health response. */
export function sendHealth(response: express.Response): void {
  response.json({ ready: true });
}

/** Send the active principal's dynamic model catalogue. */
export async function sendModels(
  gateway: ModelGateway,
  request: express.Request,
  response: express.Response,
): Promise<void> {
  const startedAt = Date.now();
  logger.debug("models request", requestContext(request));
  try {
    const payload = await gateway.models(
      request.header("originator"),
      optionalSearch(request.query.search),
    );
    response.json(payload);
    logger.debug("models response", {
      ...requestContext(request),
      elapsedMs: Date.now() - startedAt,
      status: response.statusCode,
    });
  } catch (error) {
    logger.error("models request failed", {
      ...requestContext(request),
      elapsedMs: Date.now() - startedAt,
      error,
    });
    sendError("openai-responses", response, error);
  }
}

/** Execute and stream one model request through Express with cancellation. */
export async function sendInference(
  gateway: ModelGateway,
  protocol: ClientProtocol,
  request: express.Request,
  response: express.Response,
): Promise<void> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const abort = () => {
    if (response.writableEnded) return;
    logger.debug("client disconnected", {
      ...requestContext(request),
      elapsedMs: Date.now() - startedAt,
      protocol,
    });
    controller.abort(new Error("Model gateway client disconnected"));
  };
  request.once("aborted", abort);
  response.once("close", abort);
  try {
    const body = record(request.body);
    logger.debug("inference request", {
      ...requestContext(request),
      model: typeof body.model === "string" ? body.model : undefined,
      protocol,
      stream: body.stream === true,
    });
    const upstream = await gateway.inference(
      protocol,
      body,
      requestHeaders(request),
      controller.signal,
    );
    response.status(upstream.status);
    upstream.headers.forEach((value, name) => response.setHeader(name, value));
    if (!upstream.body) {
      response.end();
      logger.debug("inference response", {
        ...requestContext(request),
        elapsedMs: Date.now() - startedAt,
        protocol,
        status: upstream.status,
        upstreamProtocol: upstream.headers.get("x-dbx-tools-upstream"),
      });
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body as never), response);
    logger.debug("inference stream completed", {
      ...requestContext(request),
      elapsedMs: Date.now() - startedAt,
      protocol,
      status: upstream.status,
      upstreamProtocol: upstream.headers.get("x-dbx-tools-upstream"),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      response.destroy();
      return;
    }
    logger.error("inference request failed", {
      ...requestContext(request),
      elapsedMs: Date.now() - startedAt,
      error,
      protocol,
    });
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    sendError(protocol, response, error);
  } finally {
    request.off("aborted", abort);
    response.off("close", abort);
  }
}

function sendError(protocol: ClientProtocol, response: express.Response, error: unknown): void {
  const status =
    error instanceof ModelGatewayError || error instanceof UnsupportedGatewayFeatureError
      ? error.status
      : 500;
  const message = error instanceof Error ? error.message : "Model gateway request failed";
  if (protocol === "anthropic-messages") {
    response.status(status).json({
      type: "error",
      error: { type: status < 500 ? "invalid_request_error" : "api_error", message },
    });
    return;
  }
  response.status(status).json({
    error: {
      message,
      type: status < 500 ? "invalid_request_error" : "api_error",
      code: status,
    },
  });
}

function requestHeaders(request: express.Request): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(request.headers)) {
    if (typeof raw === "string") headers.set(name, raw);
    else if (Array.isArray(raw)) headers.set(name, raw.join(", "));
  }
  return headers;
}

function record(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new ModelGatewayError(400, "Request body must be a JSON object");
}

function optionalSearch(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ModelGatewayError(400, "search must be a string");
  }
  return value;
}

function requestContext(request: express.Request): Record<string, unknown> {
  return {
    method: request.method,
    path: request.path,
    requestId: request.header("x-request-id") ?? request.header("request-id"),
  };
}
