/**
 * Vercel AI SDK language-model providers for Databricks Model Serving.
 *
 * @module
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenResponses } from "@ai-sdk/open-responses";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import * as invoke from "@dbx-tools/model/invoke";
import {
  rewriteServingRequest,
  rewriteServingResponseBody,
  rewriteServingResponseStream,
} from "./serving-wire.ts";

/** Databricks inference protocol exposed through a Vercel AI SDK provider. */
export type DatabricksLanguageModelProtocol = "chat" | "responses" | "anthropic";

/** ProviderV4 language-model instance returned by the Databricks factories. */
export type DatabricksLanguageModel = ReturnType<ReturnType<typeof createOpenResponses>>;

/** Inputs required to construct one request-scoped Databricks language model. */
export interface DatabricksLanguageModelOptions {
  /** Resolved Databricks serving endpoint id. */
  modelId: string;
  /** Native protocol used to invoke the endpoint. */
  protocol: DatabricksLanguageModelProtocol;
  /** Databricks workspace host. */
  host: string;
  /** Fresh request-scoped Databricks authentication headers. */
  headers: Readonly<Record<string, string>>;
  /** Provider-options namespace. Defaults to `openai` or `anthropic`. */
  providerName?: string;
  /** Fetch implementation used by the provider. */
  fetch?: typeof globalThis.fetch;
}

/** Build a Vercel AI SDK model for one Databricks serving endpoint. */
export function createDatabricksLanguageModel(
  options: DatabricksLanguageModelOptions,
): DatabricksLanguageModel {
  const headers = { ...options.headers };
  switch (options.protocol) {
    case "responses":
      return createOpenResponses({
        name: options.providerName ?? "openai",
        url: invoke.responsesUrl(options.host),
        headers,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })(options.modelId);
    case "anthropic":
      return createAnthropic({
        name: options.providerName ?? "anthropic",
        baseURL: invoke.anthropicBaseUrl(options.host),
        authToken: bearerToken(headers),
        headers,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })(options.modelId);
    case "chat":
      return createOpenAICompatible({
        name: options.providerName ?? "openai",
        baseURL: invoke.servingEndpointsUrl(options.host),
        headers,
        supportsStructuredOutputs: true,
        fetch: createDatabricksServingFetch(options.fetch),
      }).chatModel(options.modelId);
    default: {
      const protocol: never = options.protocol;
      throw new Error(`Unsupported Databricks model protocol: ${protocol}`);
    }
  }
}

/**
 * Build a provider-local fetch that normalizes Databricks Chat Completions
 * requests and responses without patching `globalThis.fetch`.
 */
export function createDatabricksServingFetch(
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): typeof globalThis.fetch {
  return (async (input, init) => {
    const rewritten = await rewriteServingRequest(input, init);
    const response = await fetcher(rewritten.input, rewritten.init);
    return repairServingResponse(response);
  }) as typeof globalThis.fetch;
}

async function repairServingResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && response.body) {
    return rebuildServingResponse(response, rewriteServingResponseStream(response.body));
  }
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  const rewritten = rewriteServingResponseBody(body);
  if (rewritten === body) return response;
  return rebuildServingResponse(response, rewritten);
}

function rebuildServingResponse(
  response: Response,
  body: string | ReadableStream<Uint8Array>,
): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
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
