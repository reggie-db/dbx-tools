/**
 * Databricks backend for the local model proxy.
 *
 * Wraps a single default-auth {@link WorkspaceClient} and exposes the three
 * things the proxy server needs, each delegating to `@dbx-tools/model`: the
 * workspace serving-endpoint list, fuzzy name resolution ({@link
 * resolve.rankModelIdLive}, so a loose `"opus"` / `"claude sonnet"` snaps to
 * the best live endpoint id - match score, then class, then within-class
 * version), and a fresh set of auth headers per upstream request ({@link
 * invoke.authHeaders}).
 *
 * What is left here is only the proxy's own policy: which client to construct,
 * and holding the endpoint catalogue for the process lifetime. The catalogue is
 * listed once and re-listed on a resolve miss, so a model deployed after
 * start-up still resolves on first use - no cache layer, just one lazy load.
 *
 * @module
 */

import { WorkspaceClient } from "@databricks/sdk-experimental";
import { invoke, resolve, serving, type ResolvedModel } from "@dbx-tools/model";
import { log } from "@dbx-tools/shared-core";
import { type ServingEndpointSummary } from "@dbx-tools/shared-model";

const logger = log.logger("model-proxy/backend");

/** Options for {@link DatabricksBackend.create}. */
export interface BackendOptions {
  /** Databricks config profile (`~/.databrickscfg`). Defaults to SDK auth resolution. */
  profile?: string;
  /** Override the workspace host; otherwise resolved from SDK auth (env / profile). */
  host?: string;
  /** Fuse.js fuzzy threshold (0 = exact, 1 = anything). Defaults to the model package default. */
  threshold?: number;
}

export class DatabricksBackend {
  private readonly client: WorkspaceClient;
  /** Resolved workspace host, e.g. `https://my-workspace.cloud.databricks.com/`. */
  readonly host: string;
  private readonly threshold: number | undefined;
  /** Lazily loaded endpoint catalogue, reused for the process lifetime. */
  private endpoints: ServingEndpointSummary[] | undefined;

  private constructor(client: WorkspaceClient, host: string, threshold: number | undefined) {
    this.client = client;
    this.host = host;
    this.threshold = threshold;
  }

  /**
   * Build a backend: construct a default-auth workspace client (optionally
   * pinned to a profile / host) and resolve the workspace host once, so a bad
   * profile fails at start-up rather than on the first proxied request.
   */
  static async create(options: BackendOptions = {}): Promise<DatabricksBackend> {
    const client = new WorkspaceClient({
      ...(options.host ? { host: options.host } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
    });
    const host = (await client.config.getHost()).toString();
    logger.info("connected", { host });
    return new DatabricksBackend(client, host, options.threshold);
  }

  /**
   * The workspace's serving-endpoint catalogue, as the minimal
   * {@link ServingEndpointSummary} the resolver needs. Loaded lazily and
   * reused; pass `force` to re-list (used by `/v1/models` and the
   * resolve-on-miss path).
   *
   * Deliberately the uncached listing: the cached one runs through AppKit's
   * `CacheManager`, which a plain CLI has no app to initialize.
   */
  async models(force = false): Promise<ServingEndpointSummary[]> {
    if (this.endpoints && !force) return this.endpoints;
    const out = await serving.listServingEndpointsUncached(this.client);
    this.endpoints = out;
    logger.debug("listed endpoints", { count: out.length });
    return out;
  }

  /**
   * Snap a (possibly loose) OpenAI-style model name to the best real serving
   * endpoint. {@link resolve.rankModelIdLive} owns the policy: rank against the
   * loaded catalogue, and on a miss re-list once and retry so a freshly
   * deployed model resolves without a restart. An unmatched name comes back
   * unchanged so a deliberate endpoint id is never silently rewritten.
   */
  async resolve(model: string): Promise<ResolvedModel> {
    return resolve.rankModelIdLive(
      (force) => this.models(force),
      model,
      this.threshold !== undefined ? { threshold: this.threshold } : {},
    );
  }

  /**
   * Mint auth headers for one upstream request. The SDK refreshes the
   * underlying token when needed, so every call gets a valid `Authorization`
   * header without the proxy tracking expiry.
   */
  async authHeaders(): Promise<Record<string, string>> {
    return invoke.authHeaders(this.client);
  }

  /** OpenAI-compatible invocations URL for a resolved endpoint id. */
  invocationsUrl(endpoint: string): string {
    return invoke.invocationsUrl(this.host, endpoint);
  }
}
