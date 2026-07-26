/**
 * AppKit plugin that builds one or more Mastra `Agent` instances and
 * mounts the `@mastra/express` server. Clients drive the conversation
 * over the standard Mastra agent stream (`@mastra/client-js`'s
 * `getAgent(id).stream()`), so there's no bespoke chat transport to
 * keep in sync.
 *
 * - Agents: registered through `config.agents` at plugin creation
 *   ({@link MastraAgentDefinition}). Each entry's `tools` field accepts
 *   either a plain record or a `(plugins) => tools` callback that gets
 *   a typed sibling-plugin index ({@link MastraPlugins}). Omit
 *   `config.agents` to get a single built-in `default` analyst.
 * - Model: each agent call resolves a `MastraModelConfig` via
 *   {@link buildModel} from `./model.js`. Per-agent `model` overrides
 *   (`AgentConfig["model"]` or a `modelId` string) flow through
 *   {@link buildAgents}.
 * - Memory / storage: per-agent, built by {@link createMemoryBuilder}
 *   from `./memory.js`. Both auto-default to `true` when the
 *   `lakebase` plugin is registered (unless the caller passed
 *   `false` or a custom config). Storage namespaces per agent via
 *   {@link agentStorageSchemaName} per agent; the vector store is a single
 *   shared singleton across every agent.
 * - Server: the Express subapp wiring lives in `./server.js`.
 * - HTTP: AppKit mounts this plugin under `/api/mastra`. Alongside the
 *   Mastra agent routes, the plugin registers `/route/history`
 *   (load + clear a thread's messages), `/route/threads` (list the
 *   caller's conversations + delete one), `/models`, `/default-model`,
 *   `/suggestions`, `/route/feedback` (log a thumbs / comment to MLflow
 *   when feedback is enabled), and the generic `/embed/:type/:id`
 *   resolver for inline chart / data markers. Each is registered through
 *   AppKit's `route()` so it lands in the plugin's endpoint map, and
 *   every outbound call one makes runs through `execute()` (see
 *   `./defaults.js`). The stock `@mastra/express` surface is gated
 *   by `config.apiAccess` (default `"scoped"`): only agent inference,
 *   read-only agent metadata, the `/route/*` routes, and (when enabled)
 *   MCP are dispatched to Mastra; admin / mutating / bulk-export routes
 *   are refused with `403`. See {@link isMastraRequestAllowed}.
 * - MCP: opt in with `config.mcp` to expose the agents (and optionally
 *   tools) as a Mastra `MCPServer`. It is registered on the `Mastra`
 *   instance via `mcpServers`, so `@mastra/express` serves the stock
 *   MCP transport routes (`/mcp/<serverId>/...`) under the mount. See
 *   `./mcp.js`.
 *
 * @module
 */

import {
  ExecutionError,
  genie,
  getExecutionContext,
  lakebase,
  Plugin,
  toPlugin,
  type ExecutionResult,
  type IAppRouter,
  type PluginManifest,
  type ResourceRequirement,
} from "@databricks/appkit";
import { plugin } from "@dbx-tools/appkit";
import { serving as nodeServing } from "@dbx-tools/model";
import { async, error, log, string } from "@dbx-tools/shared-core";
import {
  feedback,
  routes,
  type Chart,
  type MastraClientConfig,
  type MastraFeedbackRequest,
  type StatementData,
} from "@dbx-tools/shared-mastra";
import { display, type ServingEndpointSummary } from "@dbx-tools/shared-model";
import type { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import express from "express";
import type { Pool } from "pg";

import { buildAgents, FALLBACK_AGENT_ID, type BuiltAgents } from "./agents";
import { fetchChart } from "./chart";
import { MASTRA_CONFIG_SCHEMA, resolveUserKey, type MastraPluginConfig } from "./config";
import {
  chartFetchDefaults,
  feedbackWriteDefaults,
  genieSuggestionDefaults,
  modelCatalogueDefaults,
  statementDataDefaults,
} from "./defaults";
import { collectSpaceSuggestions, resolveGenieSpaces } from "./genie";
import { historyRoute } from "./history";
import { buildMcpServer, type ResolvedMcp } from "./mcp";
import { createMemoryBuilder, createServicePrincipalPool, needsLakebase } from "./memory";
import { logFeedback, resolveFeedbackEnabled } from "./mlflow";
import { buildObservability } from "./observability";
import { attachRoutePatchMiddleware, isMastraRequestAllowed, MastraServer } from "./server";
import { resolveServingConfig } from "./serving";
import { fetchStatementData, STATEMENT_ROW_CAP } from "./statement";
import { threadsRoute } from "./threads";
import { invalidFields } from "./validation";

const GENIE_MANIFEST = plugin.data(genie).plugin.manifest;
const LAKEBASE_MANIFEST = plugin.data(lakebase).plugin.manifest;

/**
 * Budget for draining the memory service-principal pool on shutdown. Well
 * inside AppKit's 15s graceful-shutdown window, so a stuck connection can
 * never be what holds the process open.
 */
const POOL_DRAIN_TIMEOUT_MS = 5_000;

/** Ceiling on the `?timeoutMs=` long-poll budget a client may request. */
const MAX_EMBED_POLL_TIMEOUT_MS = 5 * 60_000;

/** Stable client message when the workspace's model catalogue can't be read. */
const MODEL_CATALOGUE_FAILED_MESSAGE = "Could not read the workspace's model catalogue";

/** Stable client message for a feedback body that fails schema validation. */
const INVALID_FEEDBACK_MESSAGE = "Invalid feedback request";

/** Cache namespace for statement result sets, matching the chart cache's form. */
const STATEMENT_CACHE_NAMESPACE = "mastra:statement";

/**
 * AppKit plugin (registered name: `mastra`) that hosts Mastra agents
 * with optional Lakebase-backed memory and AI SDK chat routes under
 * the plugin mount (typically `/api/mastra`).
 *
 * @example Register the plugin
 * ```ts
 * import { createApp, lakebase } from "@databricks/appkit";
 * import { createAgent, mastra } from "@dbx-tools/appkit-mastra";
 *
 * // `lakebase` first: registering it auto-enables Mastra storage + memory.
 * const app = await createApp({
 *   plugins: [
 *     lakebase(),
 *     mastra({
 *       genieSpaces: { default: process.env.DATABRICKS_GENIE_SPACE_ID! },
 *       agents: createAgent({
 *         name: "analyst",
 *         instructions: "You answer questions about revenue and returns.",
 *         tools(plugins) {
 *           return { ...plugins.genie?.toolkit() };
 *         },
 *       }),
 *     }),
 *   ],
 * });
 * ```
 *
 * @example Read the agents back off the AppKit instance
 * ```ts
 * const agentIds = app.mastra.list();
 * const endpoints = await app.mastra.listModels();
 * ```
 */
export class MastraPlugin extends Plugin<MastraPluginConfig> {
  // Annotated rather than left to `satisfies`: the config schema's type comes
  // from `@types/json-schema`, which this package does not depend on, so an
  // inferred manifest type cannot be named in the emitted declaration. The
  // `PluginManifest<"mastra">` parameter still carries the literal name into
  // `toPlugin()`'s factory type.
  static manifest: PluginManifest<"mastra"> = {
    name: "mastra",
    displayName: "Mastra",
    description:
      "Builds a Mastra Agent with user-scoped workspace auth (asUser) " +
      "and optional Postgres-backed Mastra Memory via the `lakebase` plugin.",
    stability: "beta",
    resources: {
      required: [],
      optional: [
        // Reuse the Genie space-id binding declared by AppKit's `genie`
        // manifest so the resource-binding shape is identical to AppKit's and
        // an existing `app.yaml` / `genie({ spaces })` wiring keeps working.
        // The built-in Genie tools talk to Genie directly through
        // `@dbx-tools/genie`, so only the binding is shared, not the plugin's
        // tools.
        ...GENIE_MANIFEST.resources.required,
        ...LAKEBASE_MANIFEST.resources.required,
      ],
    },
    config: { schema: MASTRA_CONFIG_SCHEMA },
  };

  /**
   * Tighten resource requirements based on which features are enabled.
   * AppKit calls this at registration time (config-aware) so disabled
   * features don't surface their resource asks to the host app.
   */
  static getResourceRequirements(config: MastraPluginConfig): ResourceRequirement[] {
    const resources: ResourceRequirement[] = [];
    const enabledManifests: PluginManifest<string>[] = [];

    if (needsLakebase(config)) {
      enabledManifests.push(LAKEBASE_MANIFEST);
    }
    for (const m of enabledManifests) {
      for (const resource of m.resources.required) {
        resources.push({ ...resource, required: true });
      }
    }
    return resources;
  }

  private logger = log.logger(this);
  private built: BuiltAgents | null = null;
  private mastra: Mastra | null = null;
  private mastraApp: express.Express | null = null;
  private mastraServer: MastraServer | null = null;
  /**
   * The optional MCP server exposing this plugin's agents / tools, or
   * `null` when `config.mcp` is disabled (the default). Built in
   * {@link buildAgentAndServer} and registered on the Mastra instance.
   */
  private mcp: ResolvedMcp | null = null;
  /**
   * Dedicated service-principal Lakebase pool backing Mastra memory /
   * storage. Built once in {@link buildAgentAndServer} (outside any
   * `asUser` scope, so it never inherits a request's OBO identity) and
   * drained in {@link shutdown}. `null` until setup runs or when
   * Lakebase isn't needed.
   */
  private servicePrincipalPool: Pool | null = null;

  override async setup(): Promise<void> {
    // Wait until sibling plugins (e.g. `lakebase`) finish `setup()` so
    // the lakebase pool is valid when storage/memory are enabled.
    this.context?.onLifecycle("setup:complete", async () => {
      this.applyLakebaseAutoDefaults();
      await this.buildAgentAndServer();
    });
  }

  /**
   * When the `lakebase` plugin is registered, auto-enable `storage`
   * and `memory` unless the caller opted out explicitly (`false` or a
   * custom config object). Run after `setup:complete` so the lookup
   * is reliable: any plugin that registers itself synchronously is
   * already in the registry by the time this fires.
   */
  private applyLakebaseAutoDefaults(): void {
    const hasLakebase = plugin.instance(this.context, lakebase) !== undefined;
    if (!hasLakebase) return;
    if (this.config.storage === undefined) this.config.storage = true;
    if (this.config.memory === undefined) this.config.memory = true;
  }

  /**
   * Drain the memory service-principal pool. Idempotent: the handle is
   * cleared before the drain starts, so a second call is a no-op and a
   * later `setup()` rebuilds the pool. Bounded by
   * {@link POOL_DRAIN_TIMEOUT_MS} to stay well inside the 15s graceful
   * shutdown budget.
   */
  async shutdown(): Promise<void> {
    const pool = this.servicePrincipalPool;
    if (!pool) return;
    this.servicePrincipalPool = null;
    this.logger.info("closing memory SP pool");
    // The budget timer is cancelled on the way out so a drain that finished
    // early cannot hold the event loop open for the rest of the window.
    const budget = new AbortController();
    try {
      await Promise.race([pool.end(), async.sleep(POOL_DRAIN_TIMEOUT_MS, budget.signal)]);
    } catch (err) {
      this.logger.error("error closing memory SP pool", {
        error: error.errorMessage(err),
      });
    } finally {
      budget.abort();
    }
  }

  /**
   * Abort in-flight work. AppKit's graceful shutdown calls this hook
   * synchronously and never awaits {@link shutdown}, so the pool drain is
   * started here too; it cannot be awaited from a `void` hook, and
   * {@link shutdown} is idempotent so the duplicate call is free.
   */
  override abortActiveOperations(): void {
    super.abortActiveOperations();
    void this.shutdown();
  }

  override exports() {
    return {
      /**
       * Ids of every registered agent in registration order. Matches
       * AppKit `agents.list()` so callers can iterate the registry the
       * same way under both plugins.
       */
      list: (): string[] => Object.keys(this.built?.agents ?? {}),
      /**
       * Look up a registered agent by id. Returns `null` (not
       * undefined) when unknown so call sites can early-return without
       * a separate `in` check.
       */
      get: (id: string): Agent | null => this.built?.agents[id] ?? null,
      /**
       * The agent the client converses with when it doesn't name one.
       * Resolves to `config.defaultAgent`, the first registered id, or
       * the built-in `default` fallback.
       */
      getDefault: (): Agent | null =>
        (this.built && this.built.agents[this.built.defaultAgentId]) ?? null,
      /** Underlying Mastra instance for advanced use (custom routes etc.). */
      getMastra: () => this.mastra,
      /**
       * MCP endpoint info when `config.mcp` is enabled, else `null`.
       * Streamable HTTP is `http`; the SSE pair is the legacy transport.
       *
       * Each path is given twice: mount-relative (`httpPath`, `ssePath`,
       * `messagePath`) for anything that already knows where the plugin is
       * mounted, and absolute (`http`, `sse`, `messages`) for MCP clients,
       * which take a single URL and cannot compose one. The absolute form is
       * built from {@link basePath}, so it honors a `config.name` override but
       * still assumes AppKit's default `/api/<name>` mount.
       */
      getMcp: (): {
        serverId: string;
        httpPath: string;
        ssePath: string;
        messagePath: string;
        http: string;
        sse: string;
        messages: string;
      } | null =>
        this.mcp
          ? {
              serverId: this.mcp.serverId,
              httpPath: this.mcp.httpPath,
              ssePath: this.mcp.ssePath,
              messagePath: this.mcp.messagePath,
              http: `${this.basePath}${this.mcp.httpPath}`,
              sse: `${this.basePath}${this.mcp.ssePath}`,
              messages: `${this.basePath}${this.mcp.messagePath}`,
            }
          : null,
      /** Express subapp Mastra is mounted on; mostly for tests. */
      getMastraServer: () => this.mastraServer,
      /**
       * Fetch the workspace's Model Serving endpoints (cached). Same
       * payload the `GET /models` route returns; surfaced here so
       * other plugins / scripts can introspect the catalogue without
       * an HTTP round-trip. AppKit wraps this with `asUser(req)` for
       * OBO scoping automatically. Throws when the listing fails, since
       * there is no status code to hand back on this surface.
       */
      listModels: (): Promise<ServingEndpointSummary[]> => this.listModels(),
      /**
       * Force-evict cached endpoint listings via AppKit's
       * `CacheManager`. Useful in tests or right after an admin
       * deploys a new endpoint and doesn't want to wait for the TTL.
       * Returns the underlying `CacheManager.delete`/`clear` promise.
       */
      clearModelsCache: (host?: string): Promise<void> =>
        nodeServing.clearServingEndpointsCache(host),
    };
  }

  /**
   * Absolute mount this plugin's routes answer on. AppKit mounts every plugin
   * at `/api/<plugin.name>` and `this.name` honors a `config.name` override,
   * so the per-route segments (`routes.MASTRA_ROUTES`) hang off this.
   */
  private get basePath(): string {
    return `/api/${this.name}`;
  }

  override clientConfig(): Record<string, unknown> {
    // Publishing `basePath` is enough for the client to stay correct under a
    // custom mount id: the per-route segments are fixed
    // (`routes.MASTRA_ROUTES`) and the client (`MastraPluginClient`) derives
    // every endpoint from `basePath`.
    // Return widens to `Record<string, unknown>` to satisfy the
    // base-class signature; consumers read it through the typed
    // `MastraClientConfig` shape via `usePluginClientConfig<...>(...)`.
    const config: MastraClientConfig = {
      basePath: this.basePath,
      defaultAgent: this.built?.defaultAgentId ?? FALLBACK_AGENT_ID,
      agents: Object.keys(this.built?.agents ?? {}),
      feedbackEnabled: this.feedbackEnabled(),
    };
    return config as unknown as Record<string, unknown>;
  }

  /**
   * Whether user feedback can be logged to MLflow. Delegates to
   * {@link resolveFeedbackEnabled} so the client-config flag and the
   * feedback route share the same gate as the server's trace-id header.
   */
  private feedbackEnabled(): boolean {
    return resolveFeedbackEnabled(this.config.feedback);
  }

  override injectRoutes(router: IAppRouter): void {
    // Expose the MCP transport at the clean `/mcp` (plus the legacy
    // `/sse` + `/messages`) under the plugin mount. `@mastra/express`
    // mounts MCP under `/mcp/<serverId>/<transport>`, and the serverId
    // defaults to the plugin name, so the raw route reads
    // `/api/mastra/mcp/mastra/mcp` (doubled segment). This runs before
    // the catch-all and rewrites the alias to the underlying route, so
    // the public path is just `/api/<plugin>/mcp`; the query string
    // (e.g. the SSE `sessionId`) is preserved.
    //
    // Middleware rather than `this.route`: it rewrites the URL for routes
    // `@mastra/express` owns further down the chain instead of answering the
    // request, which `RouteConfig` has no shape for.
    router.use((req, _res, next) => {
      const target = this.mcpRouteAlias(req.path);
      if (target) {
        const q = req.url.indexOf("?");
        req.url = q >= 0 ? target + req.url.slice(q) : target;
      }
      next();
    });

    // `GET /models` exposes the cached endpoint list so clients can
    // populate model pickers, validate `?model=` choices, etc. Must
    // be registered before the catch-all that forwards everything to
    // the Mastra subapp.
    this.route(router, {
      name: "models",
      method: "get",
      path: routes.MASTRA_ROUTES.models,
      handler: async (req, res) => {
        const result = await this.asUser(req).listModelsResult();
        if (!result.ok) {
          this.sendFailure(res, result, "models", MODEL_CATALOGUE_FAILED_MESSAGE);
          return;
        }
        res.json({ endpoints: result.data });
      },
    });

    // `GET /default-model` (and `/default-model/:agentId`) reports the static
    // serving-endpoint an agent falls back to when the client pins no model,
    // so the picker can label its default option with the model's humanized
    // name. Agent-scoped via the optional `/:agentId` suffix (URL symmetry
    // with the history / threads / suggestions routes), defaulting to the
    // default agent. `model` / `displayName` are null when the agent has no
    // static default (a dynamic, call-time model); an unknown agent id is a
    // 404, matching the history / threads routes. Reads only in-memory build
    // state, so it needs no OBO scoping. Registered before the catch-all,
    // same as `/models`.
    const handleDefaultModel = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      const requested = string.firstNonEmpty(req.params.agentId);
      if (requested !== null && !this.built?.agents[requested]) {
        res.status(404).json({ error: this.unknownAgentMessage(requested) });
        return;
      }
      const agentId = requested ?? this.built?.defaultAgentId ?? FALLBACK_AGENT_ID;
      const raw = this.built?.defaultModels[agentId];
      // `"<dynamic>"` (a call-time function) has no fixed id to advertise.
      const model = raw && raw !== "<dynamic>" ? raw : null;
      // Return the humanized label too, so the picker shows a friendly name on
      // load without waiting on the `/models` catalogue (no raw-id flash).
      res.json({
        agentId,
        model,
        displayName: model ? display.toModelDisplayName(model) : null,
      });
    };
    this.route(router, {
      name: "defaultModel",
      method: "get",
      path: routes.MASTRA_ROUTES.defaultModel,
      handler: handleDefaultModel,
    });
    this.route(router, {
      name: "defaultModelByAgent",
      method: "get",
      path: `${routes.MASTRA_ROUTES.defaultModel}/:agentId`,
      handler: handleDefaultModel,
    });

    // `GET /embed/:type/:id` is the single resolver for every embed
    // marker the agent emits in prose (`[chart:<id>]`,
    // `[data:<id>]`, ...). `:type` selects a resolver from the
    // registry below; `:id` is that resolver's lookup key. The
    // grammar (see `marker.ts`) is type-agnostic on purpose - new
    // embed kinds are added by registering a resolver here, with no
    // client or grammar change.
    //
    // Status codes:
    //   - 200 with the resolver's JSON body when the id resolves.
    //   - 404 when `:type` isn't registered (unsupported embed
    //     type) OR a registered resolver can't find `:id` (unknown
    //     / expired - e.g. a chart past its 1h TTL or a fabricated
    //     id the model never minted).
    //   - 400 when `:id` is empty.
    //
    // Per-type query knobs and behavior:
    //   - `chart`: long-polls the chart cache until the entry
    //     settles (`result` / `error`) or the budget elapses (then
    //     returns the still-processing entry to poll again).
    //     `?timeoutMs=<n>` (default 60s, capped 5min) tunes it.
    //   - `data`: one OBO-scoped Statement Execution fetch.
    //     `?limit=<n>` caps rows (clamped to STATEMENT_ROW_CAP).
    //
    // Built once (this handler is registered once) and keyed by the
    // raw `:type` token. Each resolver gets the request (for query
    // parsing + OBO scoping) and an `AbortSignal` bridged off the
    // connection `close` event so a long-poll unblocks the instant
    // the client disconnects. `undefined` from a resolver maps to a
    // clean 404; thrown errors bubble through `next(err)`.
    const embedResolvers: Record<string, EmbedResolver> = {
      chart: (req, id, signal) => {
        const timeoutMs = parseTimeoutMs(req.query.timeoutMs);
        return this.asUser(req).fetchChartEntry(id, {
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          signal,
        });
      },
      data: (req, id, signal) => {
        const limit = parseStatementLimit(req.query.limit);
        return this.asUser(req).fetchStatement(id, {
          ...(limit !== undefined ? { limit } : {}),
          signal,
        });
      },
    };

    this.route(router, {
      name: "embed",
      method: "get",
      path: `${routes.MASTRA_ROUTES.embed}/:type/:id`,
      handler: async (req, res) => {
        const type = string.firstNonEmpty(req.params.type) ?? "";
        const id = string.firstNonEmpty(req.params.id);
        const resolve = embedResolvers[type];
        if (!resolve) {
          res.status(404).json({ error: `unsupported embed type: ${type}` });
          return;
        }
        if (!id) {
          res.status(400).json({ error: "id is required" });
          return;
        }
        // Express's `req` predates `AbortSignal`; bridge the `close`
        // event onto an `AbortController` so a closed connection
        // unblocks any long-poll immediately and frees the request
        // thread. The listener is GC'd with the request on normal
        // completion.
        const controller = new AbortController();
        req.on("close", () => controller.abort());
        const result = await resolve(req, id, controller.signal);
        if (controller.signal.aborted) return;
        if (!result.ok) {
          this.sendFailure(res, result, `embed:${type}`, `Could not resolve the ${type} embed`);
          return;
        }
        if (result.data === undefined) {
          res.status(404).json({ error: `${type} not found` });
          return;
        }
        res.json(result.data);
      },
    });

    // `GET /suggestions` (and `/suggestions/:agentId`) returns the
    // curated starter questions for the agent's Genie space(s) - the
    // author-configured `sample_questions`, surfaced as one-tap
    // prompts on the chat empty state. Returns `{ questions: [] }`
    // when no Genie space is wired so the client renders a bare
    // empty state (no built-in example prompts). The `:agentId`
    // segment is accepted for URL symmetry with the chat / history
    // routes; Genie spaces are resolved per-plugin, not per-agent,
    // so it doesn't change the result. OBO-scoped like the other
    // data routes so the space lookup runs as the calling user.
    const handleSuggestions = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      const controller = new AbortController();
      req.on("close", () => controller.abort());
      const result = await this.asUser(req).fetchSuggestions(controller.signal);
      if (controller.signal.aborted) return;
      if (!result.ok) {
        // Suggestions are a non-critical enhancement; a lookup failure should
        // leave the chat usable with a bare empty state rather than surfacing
        // the upstream status. Log and degrade.
        this.logger.warn("suggestions:error", {
          status: result.status,
          error: result.message,
        });
        res.json({ questions: [] });
        return;
      }
      res.json({ questions: result.data });
    };
    this.route(router, {
      name: "suggestions",
      method: "get",
      path: routes.MASTRA_ROUTES.suggestions,
      handler: handleSuggestions,
    });
    this.route(router, {
      name: "suggestionsByAgent",
      method: "get",
      path: `${routes.MASTRA_ROUTES.suggestions}/:agentId`,
      handler: handleSuggestions,
    });

    // `POST /route/feedback` logs a thumbs / comment assessment against
    // a turn's MLflow trace (the `traceId` the client captured from the
    // stream response's trace-id header). Registered on the AppKit
    // router (like `/models`) rather than the Mastra subapp so it runs
    // under the same OBO scope - the feedback is attributed to the
    // signed-in user. Returns 404 when feedback is disabled so the
    // client treats the capability as absent; 400 on a malformed body.
    // A recorded assessment yields `{ ok: true }`; a soft failure (most
    // often the trace hasn't finished exporting to MLflow yet) yields
    // `{ ok: false }` without a 5xx so the UI can prompt a retry.
    this.route(router, {
      name: "feedback",
      method: "post",
      path: routes.MASTRA_ROUTES.feedback,
      handler: async (req, res) => {
        if (!this.feedbackEnabled()) {
          res.status(404).json({ ok: false });
          return;
        }
        const parsed = feedback.MastraFeedbackRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          // A Zod issue string quotes the received body back, so only the
          // offending field names travel; the full issue list is logged.
          this.logger.warn("feedback:invalid", { error: parsed.error.message });
          res.status(400).json({
            ok: false,
            error: INVALID_FEEDBACK_MESSAGE,
            fields: invalidFields(parsed.error),
          });
          return;
        }
        const result = await this.asUser(req).logFeedback(parsed.data);
        if (!result.ok) {
          this.sendFailure(res, result, "feedback", "Feedback could not be recorded");
          return;
        }
        const assessmentId = result.data;
        res.json({
          ok: assessmentId !== undefined,
          ...(assessmentId ? { assessmentId } : {}),
        });
      },
    });

    // Middleware rather than `this.route`: this is the catch-all that hands
    // every remaining method / path pair to the Mastra sub-app, so it has no
    // single method or path to register under.
    router.use((req, res, next) => {
      if (!this.mastraApp) return res.status(503).end();
      // Gate the stock Mastra surface before dispatch. In the default
      // "scoped" mode only agent inference, read-only agent metadata, this
      // plugin's own `/route/*` routes, and (when enabled) MCP reach Mastra;
      // admin / mutating / bulk-export routes are refused here. `req.path`
      // is mount-relative under the plugin mount. See `server.ts`.
      if (
        !isMastraRequestAllowed(req.method, req.path, {
          access: this.config.apiAccess ?? "scoped",
          // Reflect the *resolved* MCP state, not raw `config.mcp`: MCP is
          // on by default (`config.mcp` undefined), so gate on whether the
          // server was actually built and mounted.
          mcpEnabled: this.mcp !== null,
        })
      ) {
        res.status(403).json({ error: "Endpoint not exposed to the client (apiAccess=scoped)" });
        return;
      }
      // Dispatch through a real method, NOT the `mastraApp` property. The
      // AppKit `asUser(req)` proxy wraps function-valued props with
      // `value.bind(target)`. `mastraApp` is an express app whose `.bind` is
      // the HTTP BIND route registrar (express defines a method per HTTP verb,
      // and BIND is one), not `Function.prototype.bind` - so binding it through
      // the proxy registers a bogus route and crashes `pathToRegexp`
      // ("path must be a string ..."). This only manifests in production where
      // an OBO token makes `userScopedSelf` return the proxy. `dispatchMastra`
      // is a plain method (its `.bind` is the normal one) and invokes
      // `this.mastraApp` off the real target, keeping the OBO scope active.
      return this.asUser(req).dispatchMastra(req, res, next);
    });
  }

  /**
   * Map a failed {@link ExecutionResult} onto the response: the status the
   * execution pipeline resolved, paired with `clientMessage` rather than the
   * result's own text, which can carry upstream detail. The full message is
   * logged under `<operation>:error`.
   */
  private sendFailure(
    res: express.Response,
    result: { status: number; message: string },
    operation: string,
    clientMessage: string,
  ): void {
    this.logger.warn(`${operation}:error`, {
      status: result.status,
      error: result.message,
    });
    if (res.headersSent) return;
    res.status(result.status).json({ error: clientMessage });
  }

  /** 404 body for a request naming an agent that isn't registered. */
  private unknownAgentMessage(agentId: string): string {
    const registered = Object.keys(this.built?.agents ?? {});
    return `Unknown agent "${agentId}". Registered agents: ${registered.join(", ") || "none"}`;
  }

  /**
   * Invoke the Mastra express sub-app. Exists as a method (instead of reading
   * `this.mastraApp` through the `asUser(req)` proxy at the call site) so the
   * proxy binds this plain method - whose `.bind` is `Function.prototype.bind`
   * - rather than the express app, whose `.bind` is the HTTP BIND route
   * registrar (see the note in `injectRoutes`). Runs inside the user scope so
   * `getExecutionContext()` returns the OBO client for the agent/model
   * resolvers.
   */
  private dispatchMastra(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void {
    this.mastraApp!(req, res, next);
  }

  /**
   * Map a clean, mount-relative MCP alias path to the underlying
   * `@mastra/express` route. Returns `null` when MCP is off or the path
   * isn't an alias. Collapses the stock `/mcp/<serverId>/<transport>`
   * layout (serverId defaults to the plugin name) down to `/mcp`,
   * `/sse`, and `/messages`.
   */
  private mcpRouteAlias(path: string): string | null {
    if (!this.mcp) return null;
    const id = this.mcp.serverId;
    if (path === "/mcp") return `/mcp/${id}/mcp`;
    if (path === "/sse") return `/mcp/${id}/sse`;
    if (path === "/messages") return `/mcp/${id}/messages`;
    return null;
  }

  /**
   * Implementation backing the `/suggestions` route. Runs inside the
   * AppKit user-context proxy so `getExecutionContext()` returns the
   * OBO-scoped client. Resolves the plugin's Genie spaces and merges
   * their curated `sample_questions` (see {@link collectSpaceSuggestions}).
   * Returns `[]` when no Genie space is configured so the client
   * shows a bare empty state instead of built-in example prompts.
   */
  private async fetchSuggestions(signal?: AbortSignal): Promise<ExecutionResult<string[]>> {
    const spaces = resolveGenieSpaces(this.config, this.context);
    if (Object.keys(spaces).length === 0) return { ok: true, data: [] };
    const client = getExecutionContext().client;
    return this.execute((executeSignal) => {
      const combined = async.combineAbortSignals(signal, executeSignal);
      return collectSpaceSuggestions({
        spaces,
        client,
        ...(combined ? { signal: combined } : {}),
      });
    }, genieSuggestionDefaults);
  }

  /**
   * Implementation backing the `/route/feedback` route. Runs inside the
   * AppKit user-context proxy so `getExecutionContext()` returns the
   * OBO-scoped client and the assessment is attributed to the signed-in
   * user (their email / id as the assessment source). Returns the
   * created assessment id on success, or `undefined` on a soft failure
   * (see {@link logFeedback} in `./mlflow.js`).
   */
  private async logFeedback(
    feedback: MastraFeedbackRequest,
  ): Promise<ExecutionResult<string | undefined>> {
    const ctx = getExecutionContext();
    const sourceId =
      "userEmail" in ctx && ctx.userEmail
        ? ctx.userEmail
        : "userId" in ctx
          ? ctx.userId
          : ctx.serviceUserId;
    return this.execute(
      () =>
        logFeedback(ctx.client, {
          ...feedback,
          ...(sourceId ? { sourceId } : {}),
        }),
      feedbackWriteDefaults,
    );
  }

  /**
   * Implementation backing the `data` embed resolver
   * (`GET /embed/data/:id`). Runs inside the AppKit user-context proxy so
   * `getExecutionContext()` returns the OBO-scoped workspace
   * client, then reuses the same `fetchStatementData` pipeline
   * the `get_statement` tool runs so the LLM and the UI see the
   * exact same shape for the same statement.
   *
   * Resolves to `undefined` data for upstream 404s so the route can map them
   * to a clean HTTP 404; any other failure comes back as a non-`ok` result
   * carrying the status to answer with.
   */
  private async fetchStatement(
    statementId: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<ExecutionResult<StatementData | undefined>> {
    const client = getExecutionContext().client;
    const limit = Math.min(options.limit ?? STATEMENT_ROW_CAP, STATEMENT_ROW_CAP);
    return this.execute(
      async (executeSignal) => {
        const combined = async.combineAbortSignals(options.signal, executeSignal);
        try {
          const data = await fetchStatementData(client, statementId, {
            limit,
            ...(combined ? { signal: combined } : {}),
          });
          return {
            columns: data.columns,
            rows: data.rows,
            rowCount: data.rowCount,
            truncated: data.rows.length < data.rowCount,
          };
        } catch (err) {
          // The Databricks SDK throws on 404; surface as `undefined`
          // so the route maps to a clean HTTP 404 instead of a 500.
          if (error.errorContext(err).notAccessible) return undefined;
          throw err;
        }
      },
      {
        default: {
          ...statementDataDefaults.default,
          // Namespaced so the key can't collide with another cache sharing the
          // manager, and keyed on `limit` because the slice is part of the
          // payload.
          cache: {
            ...statementDataDefaults.default.cache,
            cacheKey: [STATEMENT_CACHE_NAMESPACE, statementId, limit],
          },
        },
      },
    );
  }

  /**
   * Implementation backing the `chart` embed resolver
   * (`GET /embed/chart/:id`). Runs inside the AppKit user-context proxy so the
   * lookup is namespaced to the calling identity: a chart minted for another
   * user is indistinguishable from an unknown id, and the route answers 404.
   */
  private async fetchChartEntry(
    chartId: string,
    options: { timeoutMs?: number; signal: AbortSignal },
  ): Promise<ExecutionResult<Chart | undefined>> {
    const userKey = resolveUserKey();
    return this.execute(
      (executeSignal) =>
        fetchChart(chartId, {
          userKey,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          signal: async.combineAbortSignals(options.signal, executeSignal) ?? options.signal,
        }),
      chartFetchDefaults,
    );
  }

  /**
   * Implementation backing the `/models` route. Runs inside the AppKit
   * user-context proxy so `getExecutionContext()` returns the OBO-scoped
   * client and the catalogue reflects what the caller can invoke.
   */
  private async listModelsResult(): Promise<ExecutionResult<ServingEndpointSummary[]>> {
    return this.execute(async () => {
      const client = getExecutionContext().client;
      const host = (await client.config.getHost()).toString();
      const serving = resolveServingConfig(this.config);
      return nodeServing.listServingEndpoints(client, host, { ttlMs: serving.ttlMs });
    }, modelCatalogueDefaults);
  }

  /**
   * Implementation backing the `listModels` export. The programmatic surface
   * carries no status code, so a failed execution becomes a throw with a
   * stable message; the routes branch on the {@link ExecutionResult} instead.
   */
  private async listModels(): Promise<ServingEndpointSummary[]> {
    const result = await this.listModelsResult();
    if (result.ok) return result.data;
    this.logger.warn("listModels:error", {
      status: result.status,
      error: result.message,
    });
    throw new ExecutionError(MODEL_CATALOGUE_FAILED_MESSAGE);
  }

  private async buildAgentAndServer(): Promise<void> {
    // Per-agent memory factory. When any storage / memory setting needs
    // Postgres, stand up a dedicated service-principal pool first so
    // memory acts as the app SP (owner of the `mastra_*` schemas),
    // never the per-request OBO identity the chat turn runs under.
    // `getPgConfig()` is read here, outside any `asUser` scope, so it
    // returns the SP connection target + token refresh plus any
    // `lakebase({ pool })` overrides; `require` turns a missing
    // sibling into a clear wiring error. The builder caches the shared
    // `PgVector` singleton so registering N agents stays cheap. See
    // `./memory.js`.
    if (needsLakebase(this.config)) {
      const spPgConfig = plugin
        .require(this.context, lakebase, this.config)
        .exports()
        .getPgConfig();
      this.servicePrincipalPool = await createServicePrincipalPool(spPgConfig);
    }
    const memoryBuilder = this.servicePrincipalPool
      ? createMemoryBuilder(this.config, this.servicePrincipalPool)
      : undefined;

    // Build every agent declared in `config.agents` (or the built-in
    // fallback when none are declared). Each agent's `model` resolves
    // workspace URL + bearer at call time so concurrent requests get
    // distinct user identities; the `asUser(req)` scope around
    // `handleChat` is what lets `getExecutionContext()` return the
    // right user inside the resolver.
    this.built = await buildAgents({
      config: this.config,
      context: this.context,
      memoryBuilder,
      log: this.logger,
    });

    // `mastra.server.apiRoutes` is only honored by Mastra's standalone
    // dev server. Since we're hosting Mastra inside our own Express
    // subapp via `@mastra/express`, custom routes must be passed to
    // the `MastraServer` constructor directly.
    //
    // `storage` here is *Mastra-instance-level* and persists workflow
    // snapshots (where suspended `requireApproval` tool calls live).
    // It's separate from each agent's `Memory.storage`, which only
    // covers thread / message history. Without it,
    // `agent.resumeStream()` errors with "could not find a suspended
    // run" and the approval UI hangs after the user clicks Approve.
    const instanceStorage = memoryBuilder?.instanceStorage();
    // Wire Mastra's tracer into AppKit's global OTel pipeline via
    // `@mastra/otel-bridge`. Mastra spans become native OTel spans on
    // whatever tracer provider `TelemetryManager` registered during
    // `createApp`, so the OTLP endpoint / headers / sampling are
    // env-driven and shared with every other AppKit plugin.
    const observability = await buildObservability({
      serviceName: this.name,
      enabled: this.config.observability,
    });
    // Optional MCP exposure: build a Mastra MCP server from the
    // registered agents (and, opt-in, the ambient tools) and register
    // it on the Mastra instance. `@mastra/express` serves the stock MCP
    // transport routes (`/mcp/<serverId>/...`) off `mcpServers`, so the
    // catch-all dispatch below already routes MCP requests under OBO -
    // no bespoke route needed. See `./mcp.js`.
    this.mcp = buildMcpServer({
      config: this.config,
      pluginName: this.name,
      displayName: MastraPlugin.manifest.displayName,
      agents: this.built.agents,
      ambientTools: this.built.ambientTools,
    });
    this.mastra = new Mastra({
      agents: this.built.agents,
      ...(instanceStorage ? { storage: instanceStorage } : {}),
      ...(observability ? { observability } : {}),
      ...(this.mcp ? { mcpServers: { [this.mcp.serverId]: this.mcp.server } } : {}),
    });
    this.mastraApp = express();
    attachRoutePatchMiddleware(this.mastraApp);
    this.mastraServer = new MastraServer(this.config, {
      app: this.mastraApp,
      mastra: this.mastra,
      prefix: "",
      customApiRoutes: [
        // `historyRoute` registers both GET (load) and DELETE
        // (clear) on the same path, so it returns an array we
        // splice in.
        ...historyRoute({
          path: routes.MASTRA_ROUTES.history,
          agent: this.built.defaultAgentId,
        }),
        // Assert the `:agentId` template type: the per-package build's
        // NodeNext resolution widens the imported `routes.MASTRA_ROUTES.history`
        // to `string` (the source/bundler typecheck keeps it a literal),
        // which would otherwise drop this out of the dynamic-agent
        // overload and demand a fixed `agent`.
        ...historyRoute({
          path: `${routes.MASTRA_ROUTES.history}/:agentId` as `${string}:agentId`,
        }),
        // `threadsRoute` registers GET (list the caller's conversation
        // threads) and DELETE (remove the targeted thread) on the same
        // path; both the default-agent and dynamic-agent mounts are
        // spliced in, mirroring the history routes above.
        ...threadsRoute({
          path: routes.MASTRA_ROUTES.threads,
          agent: this.built.defaultAgentId,
        }),
        ...threadsRoute({
          path: `${routes.MASTRA_ROUTES.threads}/:agentId` as `${string}:agentId`,
        }),
      ],
    });
    await this.mastraServer.init();
    this.logger.info("ready", {
      agents: Object.keys(this.built.agents),
      defaultAgent: this.built.defaultAgentId,
      apiAccess: this.config.apiAccess ?? "scoped",
      mcp: this.mcp ? `${this.basePath}${this.mcp.httpPath}` : "off",
      lakebase: memoryBuilder !== undefined,
      feedback: this.feedbackEnabled(),
      observability: observability !== undefined ? "mlflow" : "off",
    });
  }
}

/**
 * Resolver for one embed `<type>` behind the generic
 * `GET /embed/:type/:id` route. Returns the JSON body to send on
 * success, or `undefined` to signal a 404 (unknown / expired id).
 * `signal` aborts when the client disconnects so long-polling
 * resolvers (e.g. `chart`) unblock immediately.
 */
type EmbedResolver = (
  req: express.Request,
  id: string,
  signal: AbortSignal,
) => Promise<ExecutionResult<unknown>>;

/**
 * Parse the optional `?timeoutMs=<n>` query parameter from a
 * `GET /embed/chart/:id` request. Accepts a positive integer up
 * to {@link MAX_EMBED_POLL_TIMEOUT_MS} (clamped) and rejects everything else
 * as `undefined` so {@link fetchChart} falls back to its default.
 * Express produces `string | string[] | undefined`; we normalize
 * to the first scalar before parsing.
 */
function parseTimeoutMs(raw: unknown): number | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.floor(n), MAX_EMBED_POLL_TIMEOUT_MS);
}

/**
 * Parse the optional `?limit=<n>` query parameter from a
 * `GET /embed/data/:id` request. Accepts a non-negative
 * integer and lets the route clamp to `STATEMENT_ROW_CAP`;
 * rejects anything else as `undefined` so the route falls back
 * to the server-side cap.
 */
function parseStatementLimit(raw: unknown): number | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

/**
 * Register the Mastra plugin on an AppKit app. Mounts the agents, the
 * `/route/*` chat surface, and (unless disabled) the MCP transport under
 * `/api/mastra`.
 *
 * @example Minimal app
 * ```ts
 * import { createApp } from "@databricks/appkit";
 * import { mastra } from "@dbx-tools/appkit-mastra";
 *
 * // No `agents`: a single built-in `default` analyst is registered, so the
 * // chat endpoint works out of the box.
 * const app = await createApp({ plugins: [mastra()] });
 * ```
 *
 * @example Two agents, a pinned model, and Genie
 * ```ts
 * import { createApp, lakebase } from "@databricks/appkit";
 * import { createAgent, mastra } from "@dbx-tools/appkit-mastra";
 *
 * const app = await createApp({
 *   plugins: [
 *     lakebase(),
 *     mastra({
 *       defaultModel: "databricks-claude-sonnet-4-6",
 *       defaultAgent: "analyst",
 *       genieSpaces: { sales: { spaceId: "01ef...", hint: "orders, returns" } },
 *       agents: {
 *         analyst: createAgent({
 *           instructions: "You answer questions about sales.",
 *           tools(plugins) {
 *             return { ...plugins.genie?.toolkit() };
 *           },
 *         }),
 *         helper: createAgent({ instructions: "You explain the analyst's answers." }),
 *       },
 *     }),
 *   ],
 * });
 * ```
 */
export const mastra = toPlugin(MastraPlugin);
