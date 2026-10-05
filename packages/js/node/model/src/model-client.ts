/**
 * Authentication-aware Databricks Model Serving client.
 *
 * This is the portable entry point used by generated Python bindings. It keeps
 * authentication, endpoint discovery, caching, normalization, ranking, route
 * selection, and published metadata in Node while exposing one small client.
 *
 * @module
 */
import {
  client as authClient,
  profile as authProfile,
  type AuthClient,
  type DatabricksAuthDependencies,
} from "@dbx-tools/auth";
import type { DatabricksProfileSummary } from "@dbx-tools/shared-auth";
import * as log from "@dbx-tools/shared-core/log";
import * as object from "@dbx-tools/shared-core/object";
import {
  ModelClass,
  type ModelMetadata,
  type ModelQuery,
  type RankedModel,
  type ResolvedModelSelection,
  type ResolveModelInput,
  type ServingEndpointSummary,
} from "@dbx-tools/shared-model/contracts";

import { normalizeEndpoints } from "./_ranking.ts";
import { lookupModels, resolveModel } from "./_selection.ts";
import { chatCompletionsUrl, invocationsUrl, responsesUpstreamUrl } from "./invoke.ts";
import { modelMetadataFor } from "./metadata.ts";
import { modelServingApi } from "./policy.ts";

const logger = log.logger("model/client");

/** Default lifetime for one live endpoint catalogue. */
export const DEFAULT_MODEL_CLIENT_CACHE_TTL_MS = 5 * 60 * 1000;

/** Authentication options exposed by the portable model client. */
export interface ModelAuthOptions {
  /** Databricks profile name. */
  profile?: string;
}

/** Construction options for {@link createModelClient}. */
export interface ModelClientOptions {
  /** Databricks authentication and profile selection options. */
  auth?: ModelAuthOptions;
  /** In-memory endpoint catalogue TTL in milliseconds. */
  cacheTtlMs?: number;
}

/** Secret-free runtime identity and cache configuration. */
export interface ModelClientStatus {
  readonly profile?: string;
  readonly host: string;
  readonly principal: string;
  readonly workspaceId?: string;
  readonly cacheTtlMs: number;
}

/** Serving protocol selected for one resolved model. */
export type ModelProtocol = "chat" | "responses" | "embeddings";

/** Model selection plus route controls. */
export interface ModelRouteInput extends ResolveModelInput {
  /** Force a live endpoint catalogue refresh before selection. */
  refresh?: boolean;
  /** Requested upstream protocol. Defaults from endpoint task and model policy. */
  protocol?: ModelProtocol;
  /** Whether authentication may run an interactive login. */
  login?: boolean;
}

/** Fully resolved Databricks route for a model request. */
export interface ModelRoute {
  readonly modelId: string;
  readonly endpoint?: ServingEndpointSummary;
  readonly source: ResolvedModelSelection["source"];
  readonly protocol: ModelProtocol;
  readonly host: string;
  readonly apiBase: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly metadata: ModelMetadata;
}

/** Stable model facade shared by Node and generated language bindings. */
export interface ModelClient {
  listModels(refresh?: boolean): Promise<ServingEndpointSummary[]>;
  searchModels(query?: ModelQuery, refresh?: boolean): Promise<RankedModel[]>;
  route(input?: ModelRouteInput): Promise<ModelRoute>;
  metadata(model: string | ServingEndpointSummary): ModelMetadata;
  status(): ModelClientStatus;
}

interface DatabricksModelClient {
  readonly auth: AuthClient;
  host(): string;
  principal(): string;
  workspaceId(): string | undefined;
  request(path: string): Promise<unknown>;
}

class AuthenticatedModelClient implements DatabricksModelClient {
  constructor(
    readonly auth: AuthClient,
    private readonly fetcher: typeof globalThis.fetch,
  ) {}

  host(): string {
    return this.auth.host;
  }

  principal(): string {
    return this.auth.principal;
  }

  workspaceId(): string | undefined {
    return this.auth.workspaceId;
  }

  async request(path: string): Promise<unknown> {
    const url = new URL(path, `${this.host().replace(/\/$/, "")}/`).toString();
    let headers = await this.auth.headers();
    let response = await this.fetcher(url, { headers });
    if (response.status === 401) {
      headers = await this.auth.headers({ refresh: true });
      response = await this.fetcher(url, { headers });
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Databricks Model Serving API ${path} returned HTTP ${response.status}: ${text}`,
      );
    }
    return text ? JSON.parse(text) : undefined;
  }
}

interface CatalogueEntry {
  readonly promise: Promise<readonly ServingEndpointSummary[]>;
  expiresAt: number;
}

const catalogueCache = new Map<string, CatalogueEntry>();

class DefaultModelClient implements ModelClient {
  constructor(
    private readonly client: DatabricksModelClient,
    private readonly cacheTtlMs: number,
  ) {}

  async listModels(refresh = false): Promise<ServingEndpointSummary[]> {
    return cloneEndpoints(await this.catalogue(refresh));
  }

  async searchModels(query: ModelQuery = {}, refresh = false): Promise<RankedModel[]> {
    return lookupModels(await this.catalogue(refresh), query).map(({ endpoint, ...ranked }) => ({
      ...ranked,
      endpoint: cloneEndpoint(endpoint),
    }));
  }

  async route(input: ModelRouteInput = {}): Promise<ModelRoute> {
    const { refresh = false, protocol: requestedProtocol, login, ...selection } = input;
    const effectiveSelection =
      requestedProtocol === "embeddings" && selection.modelClass === undefined
        ? { ...selection, modelClass: ModelClass.Embedding }
        : selection;
    const catalogue = await this.catalogue(refresh);
    let resolved = resolveModel(catalogue, effectiveSelection);
    if (isUnmatchedExplicit(catalogue, effectiveSelection, resolved)) {
      resolved = resolveModel(await this.catalogue(true), effectiveSelection);
    }
    const endpoint = (await this.catalogue(false)).find(
      (candidate) => candidate.name === resolved.modelId,
    );
    const protocol = requestedProtocol ?? inferProtocol(endpoint, resolved.modelId);
    const host = this.client.host();
    const url = routeUrl(host, resolved.modelId, protocol);
    const headers = await this.client.auth.headers({ login });
    return {
      modelId: resolved.modelId,
      ...(endpoint ? { endpoint: cloneEndpoint(endpoint) } : {}),
      source: resolved.source,
      protocol,
      host,
      apiBase: new URL("serving-endpoints", `${host.replace(/\/$/, "")}/`).toString(),
      url,
      headers,
      metadata: modelMetadataFor(endpoint ?? resolved.modelId),
    };
  }

  metadata(model: string | ServingEndpointSummary): ModelMetadata {
    return modelMetadataFor(model);
  }

  status(): ModelClientStatus {
    return {
      ...(this.client.auth.profile ? { profile: this.client.auth.profile } : {}),
      host: this.client.host(),
      principal: this.client.principal(),
      ...(this.client.workspaceId() ? { workspaceId: this.client.workspaceId() } : {}),
      cacheTtlMs: this.cacheTtlMs,
    };
  }

  private catalogue(refresh: boolean): Promise<readonly ServingEndpointSummary[]> {
    const key = catalogueKey(this.client);
    if (refresh) catalogueCache.delete(key);
    const current = catalogueCache.get(key);
    if (current && Date.now() < current.expiresAt) return current.promise;
    const promise = this.fetchCatalogue();
    const entry: CatalogueEntry = { promise, expiresAt: Number.POSITIVE_INFINITY };
    catalogueCache.set(key, entry);
    void promise.then(
      () => {
        entry.expiresAt = Date.now() + this.cacheTtlMs;
      },
      () => {
        if (catalogueCache.get(key) === entry) catalogueCache.delete(key);
      },
    );
    return promise;
  }

  private async fetchCatalogue(): Promise<readonly ServingEndpointSummary[]> {
    const startedAt = Date.now();
    const response = await this.client.request("/api/2.0/serving-endpoints");
    if (!object.isRecord(response) || !Array.isArray(response.endpoints)) {
      throw new Error("Databricks serving-endpoints response is missing an endpoints array");
    }
    const endpoints = normalizeEndpoints(response.endpoints);
    logger.debug("listed", {
      count: endpoints.length,
      host: this.client.host(),
      elapsedMs: Date.now() - startedAt,
    });
    return endpoints;
  }
}

/** Create an authentication-aware Databricks model client. */
export async function createModelClient(options: ModelClientOptions = {}): Promise<ModelClient> {
  const cacheTtlMs = validateCacheTtl(options.cacheTtlMs);
  return new DefaultModelClient(
    new AuthenticatedModelClient(await authClient.createAuthClient(options.auth), globalThis.fetch),
    cacheTtlMs,
  );
}

/** List configured Databricks profiles outside the model client facade. */
export function listProfiles(refresh = false): DatabricksProfileSummary[] {
  return authProfile.listProfiles({ refresh });
}

/** @internal Construct a model client around a test or host-owned Databricks client. */
export function createModelClientWithDatabricksClient(
  client: DatabricksModelClient,
  cacheTtlMs = DEFAULT_MODEL_CLIENT_CACHE_TTL_MS,
): ModelClient {
  return new DefaultModelClient(client, validateCacheTtl(cacheTtlMs));
}

/** @internal Create a model client with injectable auth host capabilities. */
export async function createModelClientWithDependencies(
  options: ModelClientOptions,
  dependencies: DatabricksAuthDependencies,
): Promise<ModelClient> {
  return new DefaultModelClient(
    new AuthenticatedModelClient(
      await authClient.createAuthClient(options.auth, dependencies),
      dependencies.fetch ?? globalThis.fetch,
    ),
    validateCacheTtl(options.cacheTtlMs),
  );
}

function validateCacheTtl(value = DEFAULT_MODEL_CLIENT_CACHE_TTL_MS): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Model client cacheTtlMs must be a positive finite number");
  }
  return value;
}

function catalogueKey(client: DatabricksModelClient): string {
  return [client.host(), client.workspaceId() ?? "", client.principal()].join("\u0000");
}

function inferProtocol(
  endpoint: ServingEndpointSummary | undefined,
  modelId: string,
): ModelProtocol {
  if (endpoint?.task === "llm/v1/embeddings") return "embeddings";
  return modelServingApi(modelId);
}

function routeUrl(host: string, modelId: string, protocol: ModelProtocol): string {
  if (protocol === "responses") return responsesUpstreamUrl(host, modelId);
  if (protocol === "chat" && modelServingApi(modelId) === "responses") {
    return chatCompletionsUrl(host);
  }
  return invocationsUrl(host, modelId);
}

function isUnmatchedExplicit(
  catalogue: readonly ServingEndpointSummary[],
  input: ResolveModelInput,
  resolved: ResolvedModelSelection,
): boolean {
  return (
    input.explicit !== undefined &&
    input.fuzzy !== false &&
    resolved.modelId === input.explicit &&
    !catalogue.some((endpoint) => endpoint.name === input.explicit)
  );
}

function cloneEndpoints(endpoints: readonly ServingEndpointSummary[]): ServingEndpointSummary[] {
  return endpoints.map(cloneEndpoint);
}

function cloneEndpoint(endpoint: ServingEndpointSummary): ServingEndpointSummary {
  return {
    ...endpoint,
    ...(endpoint.profile ? { profile: { ...endpoint.profile } } : {}),
    ...(endpoint.serviceNames ? { serviceNames: { ...endpoint.serviceNames } } : {}),
    ...(endpoint.reasoningEfforts ? { reasoningEfforts: [...endpoint.reasoningEfforts] } : {}),
    ...(endpoint.status ? { status: { ...endpoint.status } } : {}),
  };
}
