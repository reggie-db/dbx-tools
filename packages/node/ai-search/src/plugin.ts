/**
 * AppKit plugin (registered name: `ai-search`) that turns a Databricks AI
 * Search (Vector Search) index into a batteries-included search surface. It is
 * the "shortcut" half of this package: register it with nothing but an index
 * name and you get, all at once -
 *
 *   - a `search` / `universal_search` / (opt-in) `add_documents` tool set for
 *     both Mastra and AppKit agents (autocomplete is a small-`limit` search);
 *   - HTTP routes under `/api/ai-search` a browser search box calls directly
 *     (`POST /` search, `POST /universal` federated, `GET /indexes` catalogue,
 *     and `POST /documents` when writes are enabled);
 *   - a `clientConfig()` payload so a UI knows the indexes, default, and page
 *     size at boot with no round-trip;
 *   - `exports()` so app code can `appkit.aiSearch.search(...)` directly.
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
import { search as searchContract, type SearchClientConfig } from "@dbx-tools/shared-ai-search";
import { log, string } from "@dbx-tools/shared-core";
import {
  AI_SEARCH_CONFIG_SCHEMA,
  DATABRICKS_INDEX_ENV,
  INDEX_ENV,
  type AiSearchPluginConfig,
} from "./config.ts";
import { toCreateIndexOptions } from "./index-tools.ts";
import { toDocumentArray } from "./query.ts";
import { getAiSearchRuntime, resetAiSearchRuntime } from "./runtime.ts";
import {
  ADD_DOCUMENTS_TOOL_DESCRIPTION,
  CREATE_INDEX_TOOL_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
  SYNC_INDEX_TOOL_DESCRIPTION,
  UNIVERSAL_SEARCH_TOOL_DESCRIPTION,
} from "./schema.ts";

const logger = log.logger("ai-search");

/** Mount-relative route (under `/api/ai-search`) for a single-index search. */
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
  resourceKey: "ai-search-index",
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
 * import { plugin as aiSearchPlugin } from "@dbx-tools/ai-search";
 *
 * await createApp({
 *   plugins: [
 *     server(),
 *     // zero-config: reads DATABRICKS_VECTOR_SEARCH_INDEX
 *     aiSearchPlugin.aiSearch(),
 *     // or go deeper:
 *     // aiSearchPlugin.aiSearch({
 *     //   index: "main.support.docs",
 *     //   indexes: ["main.support.docs", "main.catalog.products"],
 *     //   columns: ["title", "url", "body"],
 *     //   mode: "hybrid",
 *     // }),
 *   ],
 * });
 * ```
 */
export class AiSearchPlugin extends Plugin<AiSearchPluginConfig> implements ToolProvider {
  static manifest = {
    name: "ai-search",
    displayName: "AI Search",
    description:
      "Search Databricks AI Search (Vector Search) indexes: agent tools, HTTP routes for a " +
      "search box, universal search across indexes, and an opt-in document write surface.",
    stability: "beta",
    resources: {
      required: [],
      optional: [INDEX_RESOURCE],
    },
    config: { schema: AI_SEARCH_CONFIG_SCHEMA },
  } satisfies PluginManifest<"ai-search">;

  /** The base path AppKit mounts this plugin's routes under. */
  private get basePath(): string {
    return `/api/${AiSearchPlugin.manifest.name}`;
  }

  /**
   * Promote the index to a required resource once a deployment pins a default,
   * through plugin config or either environment name.
   */
  static getResourceRequirements(config: AiSearchPluginConfig): ResourceRequirement[] {
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
    const { config } = getAiSearchRuntime(this.config);
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
    const { config } = getAiSearchRuntime(this.config);
    logger.info("ready", {
      defaultIndex: config.defaultIndex ?? "(none - pass per request)",
      indexes: config.indexes.map((i) => i.alias),
      pageSize: config.pageSize,
      mode: config.mode,
      allowWrite: config.allowWrite,
      basePath: this.basePath,
    });
  }

  /** Drop the shared runtime so a restarted app re-resolves config. */
  async shutdown(): Promise<void> {
    resetAiSearchRuntime();
  }

  override abortActiveOperations(): void {
    super.abortActiveOperations();
    void this.shutdown();
  }

  /**
   * Mount the search routes under `/api/ai-search`. Each is wrapped in
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
        const request = searchContract.searchRequestSchema.parse(req.body ?? {});
        const result = await this.asUser(req).runSearch(request);
        res.json(result);
      },
    });
    this.route(router, {
      name: "universalSearch",
      method: "post",
      path: UNIVERSAL_ROUTE,
      handler: async (req, res) => {
        const request = searchContract.universalSearchRequestSchema.parse(req.body ?? {});
        const result = await this.asUser(req).runUniversalSearch(request);
        res.json(result);
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
        const { config } = getAiSearchRuntime();
        if (!config.allowWrite) {
          res.status(403).json({ error: "the document write surface is disabled" });
          return;
        }
        const result = await this.asUser(req).runAddDocuments(req.body ?? {});
        res.json(result);
      },
    });
    this.route(router, {
      name: "createIndex",
      method: "post",
      path: INDEX_ROUTE,
      handler: async (req, res) => {
        const { config } = getAiSearchRuntime();
        if (!config.allowWrite) {
          res.status(403).json({ error: "the index write surface is disabled" });
          return;
        }
        const result = await this.asUser(req).runCreateIndex(req.body ?? {});
        res.json(result);
      },
    });
    this.route(router, {
      name: "syncIndex",
      method: "post",
      path: INDEX_SYNC_ROUTE,
      handler: async (req, res) => {
        const { config } = getAiSearchRuntime();
        if (!config.allowWrite) {
          res.status(403).json({ error: "the index write surface is disabled" });
          return;
        }
        const result = await this.asUser(req).runSyncIndex(req.body ?? {});
        res.json(result);
      },
    });
  }

  /** Surface the index catalogue + defaults so a search box needs no round-trip. */
  override clientConfig(): Record<string, unknown> {
    const { config } = getAiSearchRuntime(this.config);
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
    const { client } = getAiSearchRuntime();
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
    const { client } = getAiSearchRuntime();
    return client.universalSearch(request.query, {
      ...(request.indexes ? { indexes: request.indexes } : {}),
      ...(request.limit ? { limit: request.limit } : {}),
      ...(request.mode ? { mode: request.mode } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  private async runAddDocuments(args: unknown, signal?: AbortSignal) {
    const record = (args ?? {}) as { index?: string; documents: unknown };
    const { client, config } = getAiSearchRuntime();
    const documents = toDocumentArray(record.documents);
    const index = record.index ?? config.defaultIndex ?? "";
    return client.addDocuments(index, documents, signal);
  }

  private async runCreateIndex(args: unknown, signal?: AbortSignal) {
    const request = searchContract.createIndexRequestSchema.parse(args);
    const { client } = getAiSearchRuntime();
    return client.createIndex(request.name, toCreateIndexOptions(request, signal));
  }

  private async runSyncIndex(args: unknown, signal?: AbortSignal) {
    const request = searchContract.syncIndexRequestSchema.parse(args);
    const { client, config } = getAiSearchRuntime();
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
 * import { plugin as aiSearchPlugin, tool as searchToolModule } from "@dbx-tools/ai-search";
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
 *     aiSearchPlugin.aiSearch({ index: "main.support.docs" }),
 *     mastraPlugin.mastra({ agents: support }),
 *   ],
 * });
 * ```
 */
export const aiSearch = toPlugin(AiSearchPlugin);
