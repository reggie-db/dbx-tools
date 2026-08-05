/**
 * A small, Meilisearch-shaped client over Databricks AI Search (Vector
 * Search). The whole point of this module is ergonomics: the Databricks SDK's
 * `vectorSearchIndexes.queryIndex({ index_name, columns, query_text,
 * query_type, num_results, filters_json })` is powerful but verbose, and the
 * response is columnar. This client hides all of that behind two objects:
 *
 * ```ts
 * const client = createSearchClient();
 * const index = client.index("main.support.docs");
 * const { hits } = await index.search("reset my password", { limit: 5 });
 * await index.addDocuments([{ id: "42", title: "Reset", body: "..." }]);
 * ```
 *
 * `client.search(query, opts)` searches the default index; `client.index(name)`
 * returns a handle bound to one index; `client.universalSearch(query)` fans a
 * query across several indexes and merges the results (Meilisearch's federated
 * / multi-search, the "universal search" the caller asked for). Everything is
 * async and cancellable, resolves the OBO workspace client from the active
 * AppKit execution context (falling back to a service-principal client outside
 * a request), and returns the browser-safe shapes from
 * `@dbx-tools/shared-search`.
 *
 * Autocomplete is just a search with a small `limit` and the raw query text -
 * hybrid mode already prefix-matches, so no separate endpoint is needed; the
 * {@link SearchIndex.autocomplete} helper is a thin, self-documenting alias.
 *
 * @module
 */

import { ExecutionError, getExecutionContext } from "@databricks/appkit";
import { Context } from "@databricks/sdk-experimental";
import { appkit, databricks } from "@dbx-tools/appkit";
import { invoke, resolve as modelResolve, serving } from "@dbx-tools/model";
import { async as sharedAsync, json, log, string } from "@dbx-tools/shared-core";
import { ModelClass } from "@dbx-tools/shared-model";
import type {
  SearchDocument,
  SearchHit,
  SearchMode,
  SearchResult,
  UpsertResult,
} from "@dbx-tools/shared-search";
import {
  DEFAULT_MODE,
  DEFAULT_PAGE_SIZE,
  DEFAULT_TIMEOUT_MS,
  indexConfigFor,
  resolveIndexName,
  type ResolvedSearchConfig,
} from "./config.ts";
import type { LakebaseSearchBackend } from "./lakebase.ts";
import {
  compileFilter,
  toHits,
  toQueryType,
  toRequestColumns,
  type QueryResponseLike,
} from "./query.ts";

type WorkspaceClientLike = appkit.WorkspaceClientLike;
const logger = log.logger("search/client");

/** Options accepted by a single-index search. */
export interface SearchOptions {
  /** Maximum hits to return. Defaults to the configured page size. */
  limit?: number;
  /** Match mode. Defaults to the configured mode (hybrid). */
  mode?: SearchMode;
  /** Columns to return per hit. Defaults to the index's configured columns. */
  columns?: readonly string[];
  /** Attribute filters as `{ column: value }` or `{ column: { ">=": n } }`. */
  filter?: Record<string, unknown>;
  /** Drop hits below this score. */
  scoreThreshold?: number;
  /** External cancellation. */
  signal?: AbortSignal;
}

/** Options accepted by a universal (federated) search. */
export interface UniversalSearchOptions {
  /** Indexes to search. Defaults to every known index. */
  indexes?: readonly string[];
  /** Maximum hits per index before merging. */
  limit?: number;
  /** Match mode. */
  mode?: SearchMode;
  /** External cancellation. */
  signal?: AbortSignal;
}

/**
 * A handle bound to one index. Modeled on Meilisearch's `client.index(uid)`:
 * `search` / `autocomplete` read, `addDocuments` / `deleteDocuments` write (to
 * a direct-access index), and `info` fetches the live definition.
 */
export class SearchIndex {
  constructor(
    readonly name: string,
    private readonly client: SearchClient,
  ) {}

  /** Search this index. See {@link SearchClient.search}. */
  search(query: string, options?: SearchOptions): Promise<SearchResult> {
    return this.client.search(query, { ...options, index: this.name });
  }

  /**
   * Autocomplete against this index: a search with a small default `limit` and
   * the raw prefix as the query. Hybrid mode already handles prefixes, so this
   * is a self-documenting alias rather than a separate code path.
   */
  autocomplete(prefix: string, options?: SearchOptions): Promise<SearchResult> {
    return this.search(prefix, { limit: 5, ...options });
  }

  /** Add or update documents in this (direct-access) index. */
  addDocuments(documents: SearchDocument[], signal?: AbortSignal): Promise<UpsertResult> {
    return this.client.addDocuments(this.name, documents, signal);
  }

  /** Delete documents from this (direct-access) index by primary key. */
  deleteDocuments(ids: Array<string | number>, signal?: AbortSignal): Promise<UpsertResult> {
    return this.client.deleteDocuments(this.name, ids, signal);
  }

  /** Fetch this index's live definition (primary key, columns, readiness). */
  info(signal?: AbortSignal): Promise<IndexInfo> {
    return this.client.getIndex(this.name, signal);
  }

  /** Trigger a sync of this (Delta Sync) index from its source table. */
  sync(signal?: AbortSignal): Promise<void> {
    return this.client.syncIndex(this.name, signal);
  }

  /** Delete this index. */
  delete(signal?: AbortSignal): Promise<void> {
    return this.client.deleteIndex(this.name, signal);
  }

  /** Create this index if it does not exist, otherwise return the existing one. */
  ensure(options?: CreateIndexOptions): Promise<IndexInfo> {
    return this.client.ensureIndex(this.name, options);
  }
}

/** A resolved live index definition. */
export interface IndexInfo {
  name: string;
  endpoint?: string;
  primaryKey?: string;
  columns: string[];
  ready: boolean;
  rowCount?: number;
  /** True for a DIRECT_ACCESS index (you supply vectors; queries embed client-side). */
  directAccess?: boolean;
}

/**
 * Options for {@link SearchClient.createIndex} / {@link SearchClient.ensureIndex}.
 * The goal is the same as the rest of the client: name a source table and a
 * text column, and everything else - the endpoint, the embedding model, the
 * index type, the sync mode - has a sensible default that infers from the
 * workspace, overridable when a deployment needs to go deeper.
 */
export interface CreateIndexOptions {
  /**
   * Source Delta table (catalog.schema.table) for a Delta Sync index. Provide
   * this for the common case: Databricks computes and syncs embeddings from it.
   * Omit it (and pass {@link embeddingDimension}) to create a direct-access
   * index you write vectors to yourself.
   */
  sourceTable?: string;
  /** Primary-key column. Defaults to `id`. */
  primaryKey?: string;
  /**
   * The text column embeddings are computed from (Delta Sync). Defaults to the
   * first of `text` / `content` / `body` present, else the caller must set it.
   */
  embeddingSourceColumn?: string;
  /**
   * Embedding model endpoint. A loose name is fuzzy-matched; when omitted the
   * best embedding endpoint in the workspace is chosen ({@link resolveEmbeddingModel}).
   */
  embeddingModel?: string;
  /** Vector Search endpoint to host the index on. Defaults to the plugin's `endpoint`. */
  endpoint?: string;
  /** For a direct-access index: the embedding vector dimension (self-managed vectors, no source table). */
  embeddingDimension?: number;
  /** For a direct-access index: the column the vector is stored in. Defaults to `embedding`. */
  embeddingVectorColumn?: string;
  /**
   * The column-name -> type map used to build a direct-access index's
   * `schema_json` (types: `string`, `int`, `long`, `float`, `double`,
   * `boolean`, `date`, `timestamp`). Must include the primary key and any
   * columns you upsert. Defaults to `{ id: "string", text: "string" }`. The
   * embedding vector column is added automatically.
   */
  schema?: Record<string, string>;
  /** Sync mode for a Delta Sync index. `TRIGGERED` (default) syncs on demand; `CONTINUOUS` keeps fresh. */
  pipelineType?: "TRIGGERED" | "CONTINUOUS";
  /** Extra columns to sync alongside the embedding source (Delta Sync). */
  columnsToSync?: string[];
  /** External cancellation. */
  signal?: AbortSignal;
}

/** Options for {@link SearchClient.ensureEndpoint}. */
export interface EnsureEndpointOptions {
  /** Wait for the endpoint to come online before returning. Defaults to false. */
  wait?: boolean;
  /** External cancellation. */
  signal?: AbortSignal;
}

/**
 * Options for {@link SearchClient.provision} - a one-call "make this index real
 * and searchable" used at boot or in a seed script. It ensures the endpoint,
 * ensures the index, and (optionally) seeds documents when the index is empty.
 */
export interface ProvisionOptions extends CreateIndexOptions {
  /** Documents to seed when the index has no rows yet. Skipped if it already has data. */
  seed?: SearchDocument[];
  /**
   * Wait for the endpoint AND index to come online before returning (needed
   * before seeding). Defaults to true. Endpoint creation can take many minutes.
   */
  wait?: boolean;
  /** How long to wait for readiness before giving up. Defaults to 20 minutes. */
  timeoutMs?: number;
}

/**
 * The AI Search client. Construct it with {@link createSearchClient} (which
 * reads a resolved config) or directly for one-off use. All reads resolve the
 * OBO workspace client from the active execution context.
 */
export class SearchClient {
  constructor(
    private readonly config: ResolvedSearchConfig = {
      indexes: [],
      pageSize: DEFAULT_PAGE_SIZE,
      mode: DEFAULT_MODE,
      basePath: "/api/search",
      timeoutMs: DEFAULT_TIMEOUT_MS,
      allowWrite: false,
    },
    private readonly workspaceClientFactory: () => WorkspaceClientLike = defaultWorkspaceClient,
    /**
     * Optional Lakebase full-text FALLBACK backend. Present only when no Vector
     * Search endpoint is configured but a Lakebase pool is available; when set,
     * search / provision / write operations delegate to it and return the exact
     * same shapes, so nothing downstream can tell which backend answered.
     */
    private readonly lakebase?: LakebaseSearchBackend,
  ) {}

  /** True when this client is answering out of the Lakebase fallback backend. */
  get usesLakebase(): boolean {
    return this.lakebase !== undefined;
  }

  /** A handle bound to one index (by full UC name or configured alias). */
  index(reference: string): SearchIndex {
    const name = resolveIndexName(this.config, reference) ?? reference;
    return new SearchIndex(name, this);
  }

  /**
   * Search one index. `index` may be a full UC name, a configured alias, or
   * omitted to use the default index. Returns hits sorted most-relevant-first.
   */
  async search(
    query: string,
    options: SearchOptions & { index?: string } = {},
  ): Promise<SearchResult> {
    const text = string.trimToEmpty(query);
    const name = resolveIndexName(this.config, options.index);
    if (name === null) {
      throw new ExecutionError("search: no index configured; set a default index or pass one", {
        context: { operation: "search" },
      });
    }
    if (this.lakebase) {
      return this.lakebase.search(name, text, {
        limit: options.limit ?? this.config.pageSize,
        ...(options.scoreThreshold !== undefined ? { scoreThreshold: options.scoreThreshold } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }
    const known = indexConfigFor(this.config, name);
    const primaryKey = known?.primaryKey;
    const columns = toRequestColumns(
      options.columns,
      known?.columns ?? this.config.columns,
      primaryKey,
    );
    const mode = options.mode ?? this.config.mode;
    const limit = options.limit ?? this.config.pageSize;

    // Databricks only manages embeddings for Delta Sync indexes, so a query
    // against a DIRECT_ACCESS index must carry a query VECTOR, not text. Embed
    // the query client-side in that case (the index type is cached after the
    // first lookup so this costs one extra call per index, not per search).
    const directAccess = await this.isDirectAccess(name, options.signal);
    const queryVector = directAccess
      ? (await this.embed([text], this.config.embeddingModel, options.signal))[0]
      : undefined;

    const response = await this.withClient("search", options.signal, async (client, context) => {
      return client.vectorSearchIndexes.queryIndex(
        {
          index_name: name,
          columns,
          ...(queryVector ? { query_vector: queryVector } : { query_text: text }),
          query_type: toQueryType(mode),
          num_results: limit,
          ...(compileFilter(options.filter) ? { filters_json: compileFilter(options.filter) } : {}),
          ...(options.scoreThreshold !== undefined
            ? { score_threshold: options.scoreThreshold }
            : {}),
        },
        context,
      );
    });

    const hits = toHits(response as QueryResponseLike, primaryKey);
    return { query: text, index: name, hits, count: hits.length };
  }

  /** Cache of index-name -> is-DIRECT_ACCESS, so a search embeds its query only when needed. */
  private readonly directAccessCache = new Map<string, boolean>();

  /** Whether an index is DIRECT_ACCESS (memoized); a lookup failure assumes Delta Sync. */
  private async isDirectAccess(name: string, signal?: AbortSignal): Promise<boolean> {
    const cached = this.directAccessCache.get(name);
    if (cached !== undefined) return cached;
    try {
      const info = await this.getIndex(name, signal);
      const value = info.directAccess ?? false;
      this.directAccessCache.set(name, value);
      return value;
    } catch {
      return false;
    }
  }

  /**
   * Fan a query across several indexes and merge the hits, sorted by score -
   * the "universal search" a single box over many collections needs. Each
   * index is searched concurrently; an index that errors is logged and skipped
   * so one bad index does not sink the whole search.
   */
  async universalSearch(
    query: string,
    options: UniversalSearchOptions = {},
  ): Promise<SearchResult> {
    const text = string.trimToEmpty(query);
    const names =
      options.indexes && options.indexes.length > 0
        ? options.indexes.map((ref) => resolveIndexName(this.config, ref) ?? ref)
        : this.config.indexes.map((i) => i.name);
    const perIndex = options.limit ?? this.config.pageSize;

    const settled = await Promise.allSettled(
      names.map(async (name) => {
        const result = await this.search(text, {
          index: name,
          limit: perIndex,
          ...(options.mode ? { mode: options.mode } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        return result.hits.map((hit): SearchHit => ({ ...hit, index: name }));
      }),
    );

    const hits = settled
      .flatMap((outcome, i) => {
        if (outcome.status === "fulfilled") return outcome.value;
        logger.warn("universal-index-failed", { index: names[i] });
        return [];
      })
      .sort((a, b) => b.score - a.score);

    return { query: text, hits, count: hits.length };
  }

  /**
   * Resolve an index reference (full UC name or configured alias) to the name
   * the API expects, failing fast when it resolves to nothing. Without this a
   * blank reference - what an omitted `index` becomes when no default is
   * configured - reaches the SDK as an empty `index_name`, which builds a
   * URL with the name segment missing and comes back as a confusing
   * `ENDPOINT_NOT_FOUND` instead of naming the real problem.
   */
  private requireIndexName(reference: string, operation: string): string {
    const name = string.trimToNull(resolveIndexName(this.config, reference) ?? reference);
    if (name === null) {
      throw new ExecutionError(
        `search: no index configured; set a default index or pass one to ${operation}`,
        { context: { operation } },
      );
    }
    return name;
  }

  /** Fetch an index's live definition. */
  async getIndex(reference: string, signal?: AbortSignal): Promise<IndexInfo> {
    const name = this.requireIndexName(reference, "getIndex");
    const index = await this.withClient("getIndex", signal, (client, context) =>
      client.vectorSearchIndexes.getIndex({ index_name: name }, context),
    );
    const directAccess = index.direct_access_index_spec !== undefined;
    const spec = index.delta_sync_index_spec ?? index.direct_access_index_spec;
    // Delta Sync surfaces its embedding source columns directly; a direct-access
    // index carries its columns in schema_json (minus the vector column).
    let columns = (spec?.embedding_source_columns ?? []).map((c) => c.name ?? "").filter(Boolean);
    const schemaJson = index.direct_access_index_spec?.schema_json;
    if (directAccess && schemaJson) {
      const schema = json.parseRecord(schemaJson) ?? {};
      const vectorNames = new Set(
        (index.direct_access_index_spec?.embedding_vector_columns ?? [])
          .map((c) => c.name)
          .filter((n): n is string => Boolean(n)),
      );
      columns = Object.keys(schema).filter((c) => !vectorNames.has(c));
    }
    return {
      name: index.name ?? name,
      ...(index.endpoint_name ? { endpoint: index.endpoint_name } : {}),
      ...(index.primary_key ? { primaryKey: index.primary_key } : {}),
      columns,
      ready: index.status?.ready ?? false,
      ...(index.status?.indexed_row_count !== undefined
        ? { rowCount: index.status.indexed_row_count }
        : {}),
      ...(directAccess ? { directAccess: true } : {}),
    };
  }

  /** Add or update documents in a direct-access index. */
  async addDocuments(
    reference: string,
    documents: SearchDocument[],
    signal?: AbortSignal,
  ): Promise<UpsertResult> {
    const name = this.requireIndexName(reference, "addDocuments");
    if (this.lakebase) {
      return this.lakebase.addDocuments(
        name,
        documents,
        this.config.ensureOnSetup?.textColumn ?? "text",
        signal,
      );
    }
    await this.withClient("addDocuments", signal, (client, context) =>
      client.vectorSearchIndexes.upsertDataVectorIndex(
        { index_name: name, inputs_json: JSON.stringify(documents) },
        context,
      ),
    );
    return { index: name, count: documents.length };
  }

  /** Delete documents from a direct-access index by primary key. */
  async deleteDocuments(
    reference: string,
    ids: Array<string | number>,
    signal?: AbortSignal,
  ): Promise<UpsertResult> {
    const name = this.requireIndexName(reference, "deleteDocuments");
    if (this.lakebase) {
      return this.lakebase.deleteDocuments(name, ids, signal);
    }
    await this.withClient("deleteDocuments", signal, (client, context) =>
      client.vectorSearchIndexes.deleteDataVectorIndex(
        { index_name: name, primary_keys: ids.map(String) },
        context,
      ),
    );
    return { index: name, count: ids.length };
  }

  /**
   * Resolve an embedding endpoint id for creating a Delta Sync index. Reuses
   * the model resolver: a configured / passed name is fuzzy-matched against the
   * live catalogue, otherwise the highest-ranked embedding endpoint is chosen.
   */
  async resolveEmbeddingModel(requested?: string, signal?: AbortSignal): Promise<string | null> {
    const explicit = string.trimToNull(requested ?? this.config.embeddingModel);
    // An explicit name that already looks like an endpoint id (no whitespace)
    // is used verbatim - no need to fetch and fuzzy-match the live catalogue.
    // A genuinely loose name (e.g. "gte large") still resolves against it.
    if (explicit && !/\s/.test(explicit)) return explicit;
    return this.withClient("resolveEmbeddingModel", signal, async (client) => {
      const host = (await client.config.getHost()).toString();
      const endpoints = await serving.listServingEndpoints(client, host);
      const { modelId } = modelResolve.resolveModel(endpoints, {
        ...(explicit ? { explicit } : { modelClass: ModelClass.Embedding }),
      });
      return string.trimToNull(modelId);
    });
  }

  /**
   * Embed text via a Databricks embedding serving endpoint, returning one
   * vector per input. Used to seed a direct-access index and to turn a search
   * query into a query vector - Databricks only manages embeddings for Delta
   * Sync indexes, so a direct-access index (no Delta table, no warehouse) needs
   * the client to embed on write and on query. The endpoint is resolved the
   * same way as for index creation when not named.
   */
  async embed(texts: string[], model?: string, signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const endpoint = await this.resolveEmbeddingModel(model, signal);
    if (!endpoint) {
      throw new ExecutionError("search: could not resolve an embedding model to embed text", {
        context: { operation: "embed" },
      });
    }
    return this.withClient("embed", signal, async (client) => {
      const host = (await client.config.getHost()).toString();
      const url = invoke.invocationsUrl(host, endpoint);
      const headers = await invoke.authHeaders(client);
      const response = await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ input: texts }),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        throw new ExecutionError(
          `search: embedding endpoint ${endpoint} failed (${response.status})`,
          { context: { operation: "embed" } },
        );
      }
      const body = (await response.json()) as { data?: Array<{ embedding: number[] }> };
      const vectors = (body.data ?? []).map((row) => row.embedding);
      if (vectors.length !== texts.length) {
        throw new ExecutionError("search: embedding response did not match the input count", {
          context: { operation: "embed" },
        });
      }
      return vectors;
    });
  }

  /** The vector dimension a model produces (embeds a probe string once). */
  private async embeddingDimension(model?: string, signal?: AbortSignal): Promise<number> {
    const [vector] = await this.embed(["dimension probe"], model, signal);
    if (!vector || vector.length === 0) {
      throw new ExecutionError("search: could not determine the embedding dimension", {
        context: { operation: "createIndex" },
      });
    }
    return vector.length;
  }

  /**
   * Create an AI Search index with as little ceremony as possible. Two shapes:
   *
   *   - **Delta Sync** (the default): pass `sourceTable`; Databricks computes
   *     embeddings from the text column and keeps the index synced. The
   *     embedding model is resolved automatically when not named.
   *   - **Direct Access**: omit `sourceTable` and pass `embeddingDimension`;
   *     you write vectors yourself via {@link addDocuments}.
   *
   * Everything else infers: the endpoint from the plugin config, the primary
   * key (`id`), the text column (`text` / `content` / `body`), and the vector
   * column (`embedding`). Returns the created index's {@link IndexInfo}.
   */
  async createIndex(name: string, options: CreateIndexOptions = {}): Promise<IndexInfo> {
    const endpoint = options.endpoint ?? this.config.endpoint;
    if (!endpoint) {
      throw new ExecutionError(
        "search: no Vector Search endpoint configured; pass `endpoint` or set it on the plugin",
        { context: { operation: "createIndex" } },
      );
    }
    const primaryKey = options.primaryKey ?? "id";
    const direct = !options.sourceTable;
    const sourceColumn = options.embeddingSourceColumn ?? "text";
    const vectorColumn = options.embeddingVectorColumn ?? "embedding";

    // Delta Sync lets Databricks embed a source column, so it needs an embedding
    // model. A direct-access index stores vectors YOU supply (Databricks only
    // supports managed embeddings on Delta Sync), so it needs a dimension; we
    // resolve one from the embedding model when not given so a direct-access
    // index still works with zero extra config (embed via `embed()` on seed +
    // query - see `provision` / `search`).
    const embeddingModel =
      (await this.resolveEmbeddingModel(options.embeddingModel, options.signal)) ?? undefined;
    if (!embeddingModel) {
      throw new ExecutionError(
        "search: could not resolve an embedding model; pass `embeddingModel`",
        { context: { operation: "createIndex" } },
      );
    }
    const dimension =
      options.embeddingDimension ?? (await this.embeddingDimension(embeddingModel, options.signal));

    const schema = {
      [primaryKey]: "string",
      [sourceColumn]: "string",
      ...(options.schema ?? {}),
    };

    const directSpec = {
      direct_access_index_spec: {
        embedding_vector_columns: [{ name: vectorColumn, embedding_dimension: dimension }],
        schema_json: JSON.stringify({ ...schema, [vectorColumn]: `array<float>` }),
      },
    };

    await this.withClient("createIndex", options.signal, (client, context) =>
      client.vectorSearchIndexes.createIndex(
        {
          name,
          endpoint_name: endpoint,
          primary_key: primaryKey,
          index_type: direct ? "DIRECT_ACCESS" : "DELTA_SYNC",
          ...(direct
            ? directSpec
            : {
                delta_sync_index_spec: {
                  source_table: options.sourceTable,
                  pipeline_type: options.pipelineType ?? "TRIGGERED",
                  embedding_source_columns: [
                    { name: sourceColumn, embedding_model_endpoint_name: embeddingModel },
                  ],
                  ...(options.columnsToSync && options.columnsToSync.length > 0
                    ? { columns_to_sync: options.columnsToSync }
                    : {}),
                },
              }),
        },
        context,
      ),
    );
    logger.info("index-created", {
      index: name,
      endpoint,
      type: direct ? "DIRECT_ACCESS" : "DELTA_SYNC",
    });
    return this.getIndex(name, options.signal);
  }

  /**
   * Create the index if it does not already exist, otherwise return the
   * existing one. Idempotent - safe to call on every boot to guarantee an
   * index is present.
   */
  async ensureIndex(name: string, options: CreateIndexOptions = {}): Promise<IndexInfo> {
    try {
      return await this.getIndex(name, options.signal);
    } catch {
      return this.createIndex(name, options);
    }
  }

  /**
   * Ensure an index exists, is online, and (optionally) holds seed data - the
   * "wire up a real index on boot" path. Idempotent and cheap to call every
   * boot: it creates the endpoint and index only if missing, waits for them to
   * come online, and seeds documents ONLY when the index is still empty.
   *
   * For the demo/dummy-data case this needs no Delta table and no warehouse:
   * the default is a MANAGED direct-access index (Databricks embeds the `text`
   * column on write and query), so seeding is just an `addDocuments` of plain
   * rows and search-by-text works immediately.
   */
  async provision(name: string, options: ProvisionOptions = {}): Promise<IndexInfo> {
    if (this.lakebase) {
      // Lakebase fallback: no endpoint, no embeddings, no vectors - just a
      // Postgres full-text table. Returns an IndexInfo-shaped result so the
      // caller's logging + readiness handling is identical to Vector Search.
      const rowCount = await this.lakebase.provision(name, {
        textColumn: options.embeddingSourceColumn ?? "text",
        ...(options.seed ? { seed: options.seed } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return {
        name,
        primaryKey: options.primaryKey ?? "id",
        columns: [],
        ready: true,
        rowCount,
      };
    }
    const wait = options.wait ?? true;
    const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
    const endpoint = options.endpoint ?? this.config.endpoint;
    if (endpoint) await this.ensureEndpoint(endpoint, { wait, signal: options.signal });

    const { seed: _seed, wait: _wait, timeoutMs: _timeoutMs, ...createOptions } = options;
    let info = await this.ensureIndex(name, createOptions);

    if (wait && !info.ready) info = await this.waitForIndexReady(name, timeoutMs, options.signal);

    const seed = options.seed ?? [];
    if (seed.length > 0 && (info.rowCount ?? 0) === 0) {
      const sourceColumn = options.embeddingSourceColumn ?? "text";
      const vectorColumn = options.embeddingVectorColumn ?? "embedding";
      // Direct-access indexes store vectors we supply, so embed the text column
      // for any seed row that did not already carry a vector.
      const needEmbed = seed.some((doc) => doc[vectorColumn] === undefined);
      let rows = seed;
      if (needEmbed) {
        const texts = seed.map((doc) => string.trimToEmpty(String(doc[sourceColumn] ?? "")));
        const vectors = await this.embed(texts, options.embeddingModel, options.signal);
        rows = seed.map((doc, i) =>
          doc[vectorColumn] === undefined ? { ...doc, [vectorColumn]: vectors[i] } : doc,
        );
      }
      await this.addDocuments(name, rows, options.signal);
      logger.info("index-seeded", { index: name, count: rows.length });
      info = await this.getIndex(name, options.signal);
    }
    return info;
  }

  /** Poll an index until it reports ready, or throw after {@link timeoutMs}. */
  private async waitForIndexReady(
    name: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<IndexInfo> {
    const deadline = Date.now() + timeoutMs;
    let info = await this.getIndex(name, signal);
    while (!info.ready) {
      if (Date.now() > deadline) {
        throw new ExecutionError(`search: index ${name} did not come online in time`, {
          context: { operation: "provision" },
        });
      }
      await sharedAsync.sleep(5000, signal);
      info = await this.getIndex(name, signal);
    }
    return info;
  }

  /** Trigger a sync of a Delta Sync index from its source table. */
  async syncIndex(reference: string, signal?: AbortSignal): Promise<void> {
    const name = this.requireIndexName(reference, "syncIndex");
    await this.withClient("syncIndex", signal, (client, context) =>
      client.vectorSearchIndexes.syncIndex({ index_name: name }, context),
    );
    logger.info("index-synced", { index: name });
  }

  /** Delete an index. */
  async deleteIndex(reference: string, signal?: AbortSignal): Promise<void> {
    const name = this.requireIndexName(reference, "deleteIndex");
    await this.withClient("deleteIndex", signal, (client, context) =>
      client.vectorSearchIndexes.deleteIndex({ index_name: name }, context),
    );
    logger.info("index-deleted", { index: name });
  }

  /** List the indexes hosted on a Vector Search endpoint (name + type only). */
  async listIndexes(endpoint?: string, signal?: AbortSignal): Promise<string[]> {
    const endpointName = endpoint ?? this.config.endpoint;
    if (!endpointName) {
      throw new ExecutionError("search: no endpoint configured to list indexes", {
        context: { operation: "listIndexes" },
      });
    }
    return this.withClient("listIndexes", signal, async (client, context) => {
      const names: string[] = [];
      for await (const index of client.vectorSearchIndexes.listIndexes(
        { endpoint_name: endpointName },
        context,
      )) {
        if (index.name) names.push(index.name);
      }
      return names;
    });
  }

  /**
   * Ensure a Vector Search endpoint exists, creating a `STANDARD` one when it
   * does not. Optionally wait for it to come online. Idempotent.
   */
  async ensureEndpoint(name?: string, options: EnsureEndpointOptions = {}): Promise<void> {
    const endpoint = name ?? this.config.endpoint;
    if (!endpoint) {
      throw new ExecutionError("search: no endpoint name to ensure", {
        context: { operation: "ensureEndpoint" },
      });
    }
    await this.withClient("ensureEndpoint", options.signal, async (client, context) => {
      try {
        await client.vectorSearchEndpoints.getEndpoint({ endpoint_name: endpoint }, context);
        return;
      } catch {
        const waiter = await client.vectorSearchEndpoints.createEndpoint(
          { name: endpoint, endpoint_type: "STANDARD" },
          context,
        );
        logger.info("endpoint-created", { endpoint });
        if (options.wait) await waiter.wait();
      }
    });
  }

  /**
   * Resolve the workspace client and run one call under a bounded timeout. The
   * caller's signal (if any) and a timeout are merged into one SDK `Context`
   * via {@link appkit.databricks.toContext}, so either unwinds the request.
   */
  private async withClient<T>(
    operation: string,
    signal: AbortSignal | undefined,
    fn: (client: WorkspaceClientLike, context?: Context) => Promise<T>,
  ): Promise<T> {
    const client = this.workspaceClientFactory();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const context = databricks.toContext(controller, signal);
    try {
      return await fn(client, context);
    } catch (err) {
      if (signal?.aborted) throw ExecutionError.canceled();
      logger.warn("execution-failed", { operation });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The OBO workspace client from the active context, or a service-principal client. */
function defaultWorkspaceClient(): WorkspaceClientLike {
  const ctx = appkit.tryGetExecutionContext();
  if (ctx?.client) return ctx.client;
  // Outside a request scope (a script, a test): a fresh env-auth client.
  return getExecutionContext().client;
}

/** Construct a {@link SearchClient} from a resolved config. */
export function createSearchClient(
  config?: ResolvedSearchConfig,
  workspaceClientFactory?: () => WorkspaceClientLike,
  lakebase?: LakebaseSearchBackend,
): SearchClient {
  return new SearchClient(config, workspaceClientFactory, lakebase);
}
