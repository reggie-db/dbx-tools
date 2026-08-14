/**
 * AppKit-compatible AI Search provider backed by Lakebase full-text search.
 *
 * @module
 */

import {
  lakebase,
  Plugin,
  toPlugin,
  ValidationError,
  type BasePluginConfig,
  type IAppRouter,
  type PluginManifest,
} from "@databricks/appkit";
import type { IndexConfig, SearchRequest, SearchResponse } from "@databricks/appkit/beta";
import { plugin as appkitPlugin } from "@dbx-tools/appkit";
import { log, object, string } from "@dbx-tools/shared-core";
import type { SearchDocument } from "@dbx-tools/shared-search";
import type express from "express";
import type { JSONSchema7 } from "json-schema";
import { LakebaseSearchBackend } from "./lakebase.ts";

const logger = log.logger("search/lakebase-plugin");

/** Per-alias Lakebase search configuration. */
export interface LakebaseAiSearchIndexConfig extends Omit<
  IndexConfig,
  "embeddingFn" | "endpointName" | "pagination" | "reranker"
> {
  /** Documents used to seed an empty full-text table during setup. */
  documents?: SearchDocument[];
  /** Document field indexed first. Defaults to `text`. */
  textColumn?: string;
}

/** Configuration for the Lakebase implementation of AppKit AI Search. */
export interface LakebaseAiSearchConfig extends BasePluginConfig {
  indexes?: Record<string, LakebaseAiSearchIndexConfig>;
  /** PostgreSQL schema that owns the generated full-text tables. */
  schema?: string;
  /** Enable the document upsert route and exported method. */
  allowWrite?: boolean;
}

const CONFIG_SCHEMA: JSONSchema7 = {
  type: "object",
  required: ["indexes"],
  properties: {
    indexes: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          indexName: { type: "string" },
          columns: { type: "array", items: { type: "string" } },
          numResults: { type: "number" },
          queryType: { enum: ["full_text"] },
          textColumn: { type: "string" },
          documents: { type: "array", items: { type: "object" } },
        },
      },
    },
    schema: { type: "string" },
    allowWrite: { type: "boolean" },
  },
};

interface ResolvedLakebaseIndex {
  alias: string;
  indexName: string;
  config: LakebaseAiSearchIndexConfig;
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? (value[0] ?? "") : value;
}

/** Lakebase implementation of the native AppKit `aiSearch` contract. */
export class LakebaseAiSearchPlugin extends Plugin<LakebaseAiSearchConfig> {
  static manifest = {
    name: "aiSearch",
    displayName: "Lakebase AI Search",
    description: "AppKit AI Search contract backed by PostgreSQL full-text search",
    stability: "beta",
    resources: { required: [], optional: [] },
    config: { schema: CONFIG_SCHEMA },
  } satisfies PluginManifest<"aiSearch">;

  declare protected config: LakebaseAiSearchConfig;
  private backend: LakebaseSearchBackend | undefined;

  override async setup(): Promise<void> {
    const lake = appkitPlugin.require(this.context, lakebase, this);
    this.backend = new LakebaseSearchBackend(
      { managedPool: () => lake.exports().pool },
      string.trimToNull(this.config.schema) ?? "public",
    );
    for (const index of this.indexes()) {
      await this.backend.provision(index.indexName, {
        textColumn: index.config.textColumn ?? "text",
        ...(index.config.documents ? { seed: index.config.documents } : {}),
      });
    }
    logger.info("ready", {
      indexes: this.indexes().map((index) => index.alias),
      schema: string.trimToNull(this.config.schema) ?? "public",
    });
  }

  override injectRoutes(router: IAppRouter): void {
    this.route(router, {
      name: "query",
      method: "post",
      path: "/:alias/query",
      handler: async (req: express.Request, res: express.Response) => {
        try {
          res.json(await this.query(routeParam(req.params.alias), req.body as SearchRequest));
        } catch (error) {
          res.status(400).json({
            error: error instanceof Error ? error.message : "Search failed",
            plugin: this.name,
          });
        }
      },
    });
    this.route(router, {
      name: "getConfig",
      method: "get",
      path: "/:alias/config",
      handler: async (req: express.Request, res: express.Response) => {
        const index = this.resolveIndex(routeParam(req.params.alias));
        res.json({
          alias: index.alias,
          columns: index.config.columns,
          queryType: "full_text",
          numResults: index.config.numResults ?? 20,
          reranker: false,
          pagination: false,
        });
      },
    });
    if (this.config.allowWrite) {
      this.route(router, {
        name: "addDocuments",
        method: "post",
        path: "/:alias/documents",
        handler: async (req: express.Request, res: express.Response) => {
          const documents = Array.isArray(req.body?.documents)
            ? req.body.documents.filter(object.isRecord)
            : [];
          res.json(await this.addDocuments(routeParam(req.params.alias), documents));
        },
      });
    }
  }

  /** Query one configured Lakebase full-text index using AppKit's response shape. */
  async query(
    alias: string,
    request: SearchRequest,
  ): Promise<SearchResponse<Record<string, unknown>>> {
    if (!request.queryText) {
      throw new ValidationError("Lakebase AI Search requires queryText");
    }
    if (request.queryVector) {
      throw new ValidationError("Lakebase AI Search does not accept queryVector");
    }
    if (request.queryType && request.queryType !== "full_text") {
      throw new ValidationError("Lakebase AI Search supports only full_text queries");
    }
    const index = this.resolveIndex(alias);
    const startedAt = performance.now();
    const result = await this.requireBackend().search(index.indexName, request.queryText, {
      limit: request.numResults ?? index.config.numResults ?? 20,
      ...(request.filters ? { filter: request.filters } : {}),
    });
    const columns = request.columns ?? index.config.columns;
    return {
      results: result.hits.map((hit) => ({
        score: hit.score,
        data: this.project({ id: hit.id, ...hit.fields }, columns),
      })),
      totalCount: result.count,
      queryTimeMs: Math.max(0, performance.now() - startedAt),
      queryType: "full_text",
      nextPageToken: null,
    };
  }

  /** Add or update documents in one configured Lakebase full-text index. */
  async addDocuments(alias: string, documents: SearchDocument[]) {
    if (!this.config.allowWrite) {
      throw new ValidationError("Lakebase AI Search writes are disabled");
    }
    const index = this.resolveIndex(alias);
    return this.requireBackend().addDocuments(
      index.indexName,
      documents.filter(object.isRecord),
      index.config.textColumn ?? "text",
    );
  }

  override clientConfig() {
    return {
      indexes: this.indexes().map((index) => ({
        alias: index.alias,
        queryType: "full_text" as const,
        pagination: false,
      })),
    };
  }

  exports() {
    return {
      providerKind: "lakebase" as const,
      query: this.query.bind(this),
      addDocuments: this.addDocuments.bind(this),
    };
  }

  async shutdown(): Promise<void> {
    await this.backend?.close();
    this.backend = undefined;
  }

  private indexes(): ResolvedLakebaseIndex[] {
    return Object.entries(this.config.indexes ?? {}).map(([alias, config]) => ({
      alias,
      indexName: string.trimToNull(config.indexName) ?? alias,
      config,
    }));
  }

  private resolveIndex(alias: string): ResolvedLakebaseIndex {
    const index = this.indexes().find((candidate) => candidate.alias === alias);
    if (!index) throw new ValidationError(`Unknown AI Search index alias "${alias}"`);
    return index;
  }

  private requireBackend(): LakebaseSearchBackend {
    if (!this.backend) throw new ValidationError("Lakebase AI Search is not initialized");
    return this.backend;
  }

  private project(
    data: Record<string, unknown>,
    columns: string[] | undefined,
  ): Record<string, unknown> {
    if (!columns?.length) return data;
    return Object.fromEntries(
      columns.filter((column) => column in data).map((column) => [column, data[column]]),
    );
  }
}

/** AppKit-compatible Lakebase AI Search provider. */
export const lakebaseAiSearch = toPlugin(LakebaseAiSearchPlugin);
