/**
 * AppKit plugin (registered name: `search`) that turns a Databricks AI
 * Search (Vector Search) index into a batteries-included search surface. It is
 * the "shortcut" half of this package: register it with nothing but an index
 * name and you get, all at once -
 *
 *   - a `search` / `universal_search` / (opt-in) `add_documents` tool set for
 *     both Mastra and AppKit agents (autocomplete is a small-`limit` search);
 *   - HTTP routes under `/api/search` a browser search box calls directly
 *     (`POST /` search, `POST /universal` federated, `GET /indexes` catalogue,
 *     and `POST /documents` when writes are enabled);
 *   - a `clientConfig()` payload so a UI knows the indexes, default, and page
 *     size at boot with no round-trip;
 *   - `exports()` so app code can `appkit.search.search(...)` directly.
 *
 * Everything runs under the caller's OBO identity (routes wrap in `asUser`),
 * so Unity Catalog ACLs on the index apply. Registering the plugin resolves
 * and logs the effective config (default index, known indexes, page size,
 * mode) so a misconfiguration shows up in the boot log rather than on the
 * first search.
 *
 * @module
 */

import {
  lakebase,
  Plugin,
  ResourceType,
  toPlugin,
  type IAppRouter,
  type PluginManifest,
  type ResourceRequirement,
} from "@databricks/appkit";
import {
  defineTool,
  executeFromRegistry,
  toolsFromRegistry,
  type AgentToolDefinition,
  type ToolProvider,
  type ToolRegistry,
} from "@databricks/appkit/beta";
import { plugin as pluginLookup } from "@dbx-tools/appkit";
import { error as errorUtil, log, string } from "@dbx-tools/shared-core";
import { search as searchContract, type SearchClientConfig } from "@dbx-tools/shared-search";
import {
  SEARCH_CONFIG_SCHEMA,
  DATABRICKS_INDEX_ENV,
  ENDPOINT_ENV,
  INDEX_ENV,
  resolveSearchConfig,
  type SearchPluginConfig,
} from "./config.ts";
import { toCreateIndexOptions } from "./index-tools.ts";
import { LakebaseSearchBackend } from "./lakebase.ts";
import { toDocumentArray } from "./query.ts";
import { getSearchRuntime, resetSearchRuntime } from "./runtime.ts";
import {
  ADD_DOCUMENTS_TOOL_DESCRIPTION,
  CREATE_INDEX_TOOL_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
  SYNC_INDEX_TOOL_DESCRIPTION,
  UNIVERSAL_SEARCH_TOOL_DESCRIPTION,
} from "./schema.ts";

const logger = log.logger("search");

/** Mount-relative route (under `/api/search`) for a single-index search. */
const SEARCH_ROUTE = "/";

/** Mount-relative route for a universal (federated) search across indexes. */
const UNIVERSAL_ROUTE = "/universal";

/** Mount-relative route serving the index catalogue a search box reads. */
const INDEXES_ROUTE = "/indexes";

/** Mount-relative route for adding documents to a direct-access index. */
const DOCUMENTS_ROUTE = "/documents";

/** Mount-relative route for creating a Vector Search index. */
const INDEX_ROUTE = "/index";

/** Mount-relative route for syncing a Delta Sync index from its source table. */
const INDEX_SYNC_ROUTE = "/index/sync";

/**
 * The AI Search index resource. Declared optional because the plugin is happy
 * with no default index (a caller can name one per request); it is promoted to
 * required once a deployment pins one. `SELECT` is the permission a query needs.
 */
const INDEX_RESOURCE = {
  type: ResourceType.VECTOR_SEARCH_INDEX,
  alias: "AI Search Index",
  resourceKey: "search-index",
  description:
    "Databricks AI Search (Vector Search) index the app searches by default " +
    "(catalog.schema.index). Optional: a request may name any index the caller can read.",
  permission: "SELECT",
  fields: {
    name: {
      env: INDEX_ENV,
      description: `Default AI Search index. ${DATABRICKS_INDEX_ENV} is also honored.`,
      discovery: {
        type: "cli",
        cliCommand:
          "databricks vector-search-indexes list-indexes --endpoint-name <ENDPOINT> --output json",
        selectField: ".name",
      },
    },
  },
} satisfies Omit<ResourceRequirement, "required">;

/**
 * AppKit plugin exposing AI Search as a search box, an agent tool set, and a
 * direct API.
 *
 * @example
 * ```ts
 * import { createApp, server } from "@databricks/appkit";
 * import { plugin as searchPlugin } from "@dbx-tools/search";
 *
 * await createApp({
 *   plugins: [
 *     server(),
 *     // zero-config: reads DATABRICKS_VECTOR_SEARCH_INDEX
 *     searchPlugin.search(),
 *     // or go deeper:
 *     // searchPlugin.search({
 *     //   index: "main.support.docs",
 *     //   indexes: ["main.support.docs", "main.catalog.products"],
 *     //   columns: ["title", "url", "body"],
 *     //   mode: "hybrid",
 *     // }),
 *   ],
 * });
 * ```
 */
export class SearchPlugin extends Plugin<SearchPluginConfig> implements ToolProvider {
  static manifest = {
    name: "search",
    displayName: "AI Search",
    description:
      "Search Databricks AI Search (Vector Search) indexes: agent tools, HTTP routes for a " +
      "search box, universal search across indexes, and an opt-in document write surface.",
    stability: "beta",
    resources: {
      required: [],
      optional: [INDEX_RESOURCE],
    },
    config: { schema: SEARCH_CONFIG_SCHEMA },
  } satisfies PluginManifest<"search">;

  /** The base path AppKit mounts this plugin's routes under. */
  private get basePath(): string {
    return `/api/${SearchPlugin.manifest.name}`;
  }

  /**
   * Promote the index to a required resource once a deployment pins a default,
   * through plugin config or either environment name.
   */
  static getResourceRequirements(config: SearchPluginConfig): ResourceRequirement[] {
    const pinned =
      string.trimToNull(config.index) ??
      string.trimToNull(process.env[INDEX_ENV]) ??
      string.trimToNull(process.env[DATABRICKS_INDEX_ENV]);
    return pinned === null ? [] : [{ ...INDEX_RESOURCE, required: true }];
  }

  /**
   * The tools this plugin offers to an AppKit agent. `search` /
   * `universal_search` are reads; `add_documents` / `create_index` /
   * `sync_index` are only offered when the write surface is enabled. None is
   * autoInheritable: every tool runs under the caller's identity, so it must be
   * granted explicitly.
   */
  private get tools(): ToolRegistry {
    const { config } = getSearchRuntime({ config: this.config });
    const registry: ToolRegistry = {
      search: defineTool({
        description: SEARCH_TOOL_DESCRIPTION,
        schema: searchContract.searchRequestSchema,
        annotations: { effect: "read", requiresUserContext: true },
        autoInheritable: false,
        execute: async (args, signal) => this.runSearch(args, signal),
      }),
      universal_search: defineTool({
        description: UNIVERSAL_SEARCH_TOOL_DESCRIPTION,
        schema: searchContract.universalSearchRequestSchema,
        annotations: { effect: "read", requiresUserContext: true },
        autoInheritable: false,
        execute: async (args, signal) => this.runUniversalSearch(args, signal),
      }),
    };
    if (config.allowWrite) {
      registry.add_documents = defineTool({
        description: ADD_DOCUMENTS_TOOL_DESCRIPTION,
        schema: searchContract.searchRequestSchema
          .pick({ index: true })
          .extend({ documents: searchContract.searchDocumentSchema.array() }),
        annotations: { effect: "write", requiresUserContext: true },
        autoInheritable: false,
        execute: async (args, signal) => this.runAddDocuments(args, signal),
      });
      registry.create_index = defineTool({
        description: CREATE_INDEX_TOOL_DESCRIPTION,
        schema: searchContract.createIndexRequestSchema,
        annotations: { effect: "write", requiresUserContext: true },
        autoInheritable: false,
        execute: async (args, signal) => this.runCreateIndex(args, signal),
      });
      registry.sync_index = defineTool({
        description: SYNC_INDEX_TOOL_DESCRIPTION,
        schema: searchContract.syncIndexRequestSchema,
        annotations: { effect: "write", requiresUserContext: true },
        autoInheritable: false,
        execute: async (args, signal) => this.runSyncIndex(args, signal),
      });
    }
    return registry;
  }

  /** Prime the shared runtime from config and log the effective policy at boot. */
  override async setup(): Promise<void> {
    // Choose a backend. Vector Search is primary; when NO Vector Search
    // endpoint is configured but the AppKit `lakebase` plugin is registered,
    // fall back to a Postgres full-text index. Both answer with the identical
    // shape, so this choice is invisible to tools, routes, and the UI.
    const lakebaseBackend = this.resolveLakebaseBackend();
    // The runtime may already have been built (config-only) when `tools()` ran
    // during registration; rebuild it so it carries the chosen backend.
    resetSearchRuntime();
    const { config } = getSearchRuntime({
      config: this.config,
      ...(lakebaseBackend ? { lakebase: lakebaseBackend } : {}),
    });
    logger.info("ready", {
      backend: lakebaseBackend ? "lakebase" : "vector-search",
      defaultIndex: config.defaultIndex ?? "(none - pass per request)",
      indexes: config.indexes.map((i) => i.alias),
      pageSize: config.pageSize,
      mode: config.mode,
      allowWrite: config.allowWrite,
      basePath: this.basePath,
      ensureOnSetup: config.ensureOnSetup
        ? (config.ensureOnSetup.index ?? config.defaultIndex)
        : "off",
    });
    // Provision a real index in the BACKGROUND so a slow first-time endpoint or
    // index build never blocks the server from coming up.
    if (config.ensureOnSetup) void this.runEnsureOnSetup(config);
  }

  /**
   * Build the Lakebase FALLBACK backend, or return `undefined` when Vector
   * Search should be used. Falls back only when there is NO Vector Search
   * endpoint configured (plugin config or `SEARCH_ENDPOINT` /
   * `DATABRICKS_VECTOR_SEARCH_ENDPOINT`) AND the sibling AppKit `lakebase`
   * plugin is registered. The pg pool is built from that plugin's
   * service-principal config exactly like `@dbx-tools/appkit-mastra`'s memory
   * pool - no auth is re-implemented here.
   */
  private resolveLakebaseBackend(): LakebaseSearchBackend | undefined {
    const config = resolveSearchConfig(this.config);
    const hasEndpoint =
      config.endpoint !== undefined ||
      string.trimToNull(process.env[ENDPOINT_ENV]) !== null ||
      string.trimToNull(process.env.DATABRICKS_VECTOR_SEARCH_ENDPOINT) !== null;
    if (hasEndpoint) return undefined;
    const lake = pluginLookup.instance(this.context, lakebase);
    if (!lake) return undefined;
    logger.info("backend-lakebase", {
      reason: "no Vector Search endpoint configured; using the Lakebase full-text fallback",
    });
    // `getPgConfig()` must be read OUTSIDE any asUser scope (as it is here at
    // setup) so it carries the SP connection target + token-refresh callback.
    return new LakebaseSearchBackend(() => lake.exports().getPgConfig());
  }

  /**
   * Ensure the endpoint + index exist and seed them, honoring `ensureOnSetup`.
   * Uses boot-time SDK auth (env / config profile) via the client's
   * out-of-request fallback. Failures are logged, never thrown - a search app
   * should still start even if provisioning is slow or a permission is missing.
   */
  private async runEnsureOnSetup(
    config: ReturnType<typeof getSearchRuntime>["config"],
  ): Promise<void> {
    const spec = config.ensureOnSetup;
    if (!spec) return;
    const index = string.trimToNull(spec.index) ?? config.defaultIndex;
    if (!index) {
      logger.warn("ensure-skipped", {
        reason: "no index name (set `index` or `ensureOnSetup.index`)",
      });
      return;
    }
    const documents = spec.documents ?? [];
    // Infer a managed-direct-access schema from the first seed row when not given.
    const schema =
      spec.schema ??
      (documents.length > 0 && !spec.sourceTable
        ? this.inferSchema(documents[0], spec.primaryKey ?? "id", spec.textColumn ?? "text")
        : undefined);
    try {
      logger.info("ensure-start", { index });
      const { client } = getSearchRuntime();
      const info = await client.provision(index, {
        ...(spec.endpoint ? { endpoint: spec.endpoint } : {}),
        ...(spec.primaryKey ? { primaryKey: spec.primaryKey } : {}),
        ...(spec.textColumn ? { embeddingSourceColumn: spec.textColumn } : {}),
        ...(spec.embeddingModel ? { embeddingModel: spec.embeddingModel } : {}),
        ...(spec.sourceTable ? { sourceTable: spec.sourceTable } : {}),
        ...(schema ? { schema } : {}),
        ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
        ...(documents.length > 0 ? { seed: documents } : {}),
      });
      logger.info("ensure-ready", {
        index: info.name,
        ready: info.ready,
        rowCount: info.rowCount ?? 0,
      });
    } catch (cause) {
      logger.warn("ensure-failed", { index, message: errorUtil.errorMessage(cause) });
    }
  }

  /** Build a Vector Search `schema_json` map from a seed document's value types. */
  private inferSchema(
    doc: Record<string, unknown>,
    primaryKey: string,
    textColumn: string,
  ): Record<string, string> {
    const schema: Record<string, string> = { [primaryKey]: "string", [textColumn]: "string" };
    for (const [key, value] of Object.entries(doc)) {
      if (key in schema) continue;
      schema[key] =
        typeof value === "number"
          ? Number.isInteger(value)
            ? "int"
            : "double"
          : typeof value === "boolean"
            ? "boolean"
            : "string";
    }
    return schema;
  }

  /** Drop the shared runtime so a restarted app re-resolves config. */
  async shutdown(): Promise<void> {
    resetSearchRuntime();
  }

  override abortActiveOperations(): void {
    super.abortActiveOperations();
    void this.shutdown();
  }

  /**
   * Mount the search routes under `/api/search`. Each is wrapped in
   * `asUser(req)` so the query runs as the requesting user and the index's
   * Unity Catalog ACLs apply. `GET /indexes` needs no user scope - it just
   * echoes the configured catalogue.
   */
  override injectRoutes(router: IAppRouter): void {
    this.route(router, {
      name: "search",
      method: "post",
      path: SEARCH_ROUTE,
      handler: async (req, res) => {
        await this.respond(res, "search", () => {
          const request = searchContract.searchRequestSchema.parse(req.body ?? {});
          return this.asUser(req).runSearch(request);
        });
      },
    });
    this.route(router, {
      name: "universalSearch",
      method: "post",
      path: UNIVERSAL_ROUTE,
      handler: async (req, res) => {
        await this.respond(res, "universalSearch", () => {
          const request = searchContract.universalSearchRequestSchema.parse(req.body ?? {});
          return this.asUser(req).runUniversalSearch(request);
        });
      },
    });
    this.route(router, {
      name: "indexes",
      method: "get",
      path: INDEXES_ROUTE,
      handler: async (_req, res) => {
        res.json(this.clientConfig());
      },
    });
    this.route(router, {
      name: "documents",
      method: "post",
      path: DOCUMENTS_ROUTE,
      handler: async (req, res) => {
        const { config } = getSearchRuntime();
        if (!config.allowWrite) {
          res.status(403).json({ error: "the document write surface is disabled" });
          return;
        }
        await this.respond(res, "addDocuments", () =>
          this.asUser(req).runAddDocuments(req.body ?? {}),
        );
      },
    });
    this.route(router, {
      name: "createIndex",
      method: "post",
      path: INDEX_ROUTE,
      handler: async (req, res) => {
        const { config } = getSearchRuntime();
        if (!config.allowWrite) {
          res.status(403).json({ error: "the index write surface is disabled" });
          return;
        }
        await this.respond(res, "createIndex", () =>
          this.asUser(req).runCreateIndex(req.body ?? {}),
        );
      },
    });
    this.route(router, {
      name: "syncIndex",
      method: "post",
      path: INDEX_SYNC_ROUTE,
      handler: async (req, res) => {
        const { config } = getSearchRuntime();
        if (!config.allowWrite) {
          res.status(403).json({ error: "the index write surface is disabled" });
          return;
        }
        await this.respond(res, "syncIndex", () => this.asUser(req).runSyncIndex(req.body ?? {}));
      },
    });
  }

  /**
   * Run a route body, turning a failure into a JSON error response.
   *
   * AppKit's `route()` registers the handler as-is, so a rejection escapes as
   * an unhandled promise rejection and takes the whole process down rather than
   * failing the one request. Every route here goes through this, so a bad index
   * name or a Vector Search API error returns 500 with a message instead of
   * killing the server.
   */
  private async respond(
    res: Parameters<Parameters<IAppRouter["post"]>[1]>[1],
    operation: string,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      res.json(await run());
    } catch (cause) {
      const message = errorUtil.errorMessage(cause);
      logger.warn("route-failed", { operation, message });
      res.status(500).json({ error: message });
    }
  }

  /** Surface the index catalogue + defaults so a search box needs no round-trip. */
  override clientConfig(): Record<string, unknown> {
    const { config } = getSearchRuntime({ config: this.config });
    const payload: SearchClientConfig = {
      indexes: config.indexes.map((index) => ({
        name: index.name,
        alias: index.alias,
        ...(index.primaryKey ? { primaryKey: index.primaryKey } : {}),
        ...(index.columns ? { columns: index.columns } : {}),
        ...(index.name === config.defaultIndex ? { isDefault: true } : {}),
      })),
      ...(config.defaultIndex ? { defaultIndex: config.defaultIndex } : {}),
      pageSize: config.pageSize,
      basePath: this.basePath,
    };
    return payload as unknown as Record<string, unknown>;
  }

  /** AppKit `ToolProvider`: the tool definitions offered to an agent. */
  getAgentTools(): AgentToolDefinition[] {
    return toolsFromRegistry(this.tools);
  }

  /** AppKit `ToolProvider`: run one tool call, validating input against its schema. */
  async executeAgentTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return executeFromRegistry(this.tools, name, args, signal);
  }

  override exports() {
    return {
      /** Search one index (default when omitted). Runs as the current context user. */
      search: (request: searchContract.SearchRequest, signal?: AbortSignal) =>
        this.runSearch(request, signal),
      /** Search across every configured index and merge the hits. */
      universalSearch: (request: searchContract.UniversalSearchRequest, signal?: AbortSignal) =>
        this.runUniversalSearch(request, signal),
      /** Add or update documents in a direct-access index (throws when writes are disabled). */
      addDocuments: (request: { index?: string; documents: unknown }, signal?: AbortSignal) =>
        this.runAddDocuments(request, signal),
      /** Create a Vector Search index (throws when writes are disabled). */
      createIndex: (request: searchContract.CreateIndexRequest, signal?: AbortSignal) =>
        this.runCreateIndex(request, signal),
      /** Sync a Delta Sync index from its source table (throws when writes are disabled). */
      syncIndex: (request: searchContract.SyncIndexRequest, signal?: AbortSignal) =>
        this.runSyncIndex(request, signal),
    };
  }

  private async runSearch(args: unknown, signal?: AbortSignal) {
    const request = searchContract.searchRequestSchema.parse(args);
    const { client } = getSearchRuntime();
    return client.search(request.query, {
      ...(request.index ? { index: request.index } : {}),
      ...(request.limit ? { limit: request.limit } : {}),
      ...(request.mode ? { mode: request.mode } : {}),
      ...(request.columns ? { columns: request.columns } : {}),
      ...(request.filter ? { filter: request.filter } : {}),
      ...(request.scoreThreshold !== undefined ? { scoreThreshold: request.scoreThreshold } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  private async runUniversalSearch(args: unknown, signal?: AbortSignal) {
    const request = searchContract.universalSearchRequestSchema.parse(args);
    const { client } = getSearchRuntime();
    return client.universalSearch(request.query, {
      ...(request.indexes ? { indexes: request.indexes } : {}),
      ...(request.limit ? { limit: request.limit } : {}),
      ...(request.mode ? { mode: request.mode } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  private async runAddDocuments(args: unknown, signal?: AbortSignal) {
    const record = (args ?? {}) as { index?: string; documents: unknown };
    const { client, config } = getSearchRuntime();
    const documents = toDocumentArray(record.documents);
    const index = record.index ?? config.defaultIndex ?? "";
    return client.addDocuments(index, documents, signal);
  }

  private async runCreateIndex(args: unknown, signal?: AbortSignal) {
    const request = searchContract.createIndexRequestSchema.parse(args);
    const { client } = getSearchRuntime();
    return client.createIndex(request.name, toCreateIndexOptions(request, signal));
  }

  private async runSyncIndex(args: unknown, signal?: AbortSignal) {
    const request = searchContract.syncIndexRequestSchema.parse(args);
    const { client, config } = getSearchRuntime();
    const index = request.index ?? config.defaultIndex ?? "";
    await client.syncIndex(index, signal);
    return { index, synced: true };
  }
}

/**
 * Register the AI Search plugin with AppKit.
 *
 * @example
 * ```ts
 * import { createApp, server } from "@databricks/appkit";
 * import { plugin as searchPlugin, tool as searchToolModule } from "@dbx-tools/search";
 * import { agents, plugin as mastraPlugin } from "@dbx-tools/appkit-mastra";
 *
 * const support = agents.createAgent({
 *   instructions: "Answer from the docs; use `search` to find them.",
 *   tools: () => ({ search: searchToolModule.searchTool() }),
 * });
 *
 * await createApp({
 *   plugins: [
 *     server(),
 *     searchPlugin.search({ index: "main.support.docs" }),
 *     mastraPlugin.mastra({ agents: support }),
 *   ],
 * });
 * ```
 */
export const search = toPlugin(SearchPlugin);
