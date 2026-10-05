/**
 * Browser-safe client for model discovery through the gateway.
 *
 * @module
 */

import {
  GatewayErrorResponseSchema,
  ModelListResponseSchema,
  type GatewayErrorResponse,
  type ModelListResponse,
} from "./models.ts";

/** Construction options for {@link createModelGatewayClient}. */
export interface ModelGatewayClientOptions {
  /** Gateway base URL. Defaults to the active browser origin. */
  readonly baseUrl?: string | URL;
  /** Injectable fetch implementation for tests or custom browser transports. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Options for one model-list request. */
export interface ListModelsOptions {
  readonly search?: string;
  readonly codex?: boolean;
  readonly signal?: AbortSignal;
}

/** Browser-safe model discovery client. */
export interface ModelGatewayClient {
  listModels(options?: ListModelsOptions): Promise<ModelListResponse>;
}

/** HTTP error returned by the model gateway. */
export class ModelGatewayClientError extends Error {
  constructor(
    readonly status: number,
    readonly response?: GatewayErrorResponse,
  ) {
    super(errorMessage(status, response));
    this.name = "ModelGatewayClientError";
  }
}

/** Create a browser-safe, schema-validating model-gateway client. */
export function createModelGatewayClient(
  options: ModelGatewayClientOptions = {},
): ModelGatewayClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async listModels(request: ListModelsOptions = {}) {
      const url = modelsUrl(options.baseUrl);
      if (request.search?.trim()) url.searchParams.set("search", request.search.trim());
      const response = await fetcher(url, {
        headers: request.codex ? { Originator: "codex" } : undefined,
        signal: request.signal,
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const error = GatewayErrorResponseSchema.safeParse(payload);
        throw new ModelGatewayClientError(response.status, error.success ? error.data : undefined);
      }
      return ModelListResponseSchema.parse(payload);
    },
  };
}

function modelsUrl(baseUrl: string | URL | undefined): URL {
  if (baseUrl !== undefined) {
    const base = new URL(baseUrl.toString());
    return new URL("v1/models", base.href.endsWith("/") ? base : `${base.href}/`);
  }
  const location = (globalThis as { location?: { href: string } }).location;
  if (!location) {
    throw new Error("Model gateway baseUrl is required outside a browser");
  }
  return new URL("/v1/models", location.href);
}

function errorMessage(status: number, response: GatewayErrorResponse | undefined): string {
  if (!response) return `Model gateway returned HTTP ${status}`;
  return "error" in response ? response.error.message : `Model gateway returned HTTP ${status}`;
}
