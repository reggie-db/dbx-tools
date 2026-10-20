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
import { lakebaseResolver, pluginRegistry, telemetry as appkitTelemetry } from "@dbx-tools/appkit";
import { sendGenieMessageFeedback } from "@dbx-tools/genie/feedback";
import { modelCatalog } from "@dbx-tools/model";
import { asyncUtils, errorUtils, log, object, stringUtils } from "@dbx-tools/shared-core";
import {
  feedback,
  routes,
  wire,
  type Chart,
  type GenieChatRequest,
  type MastraClientConfig,
  type StatementData,
} from "@dbx-tools/shared-mastra";
import { display, type ServingEndpointSummary } from "@dbx-tools/shared-model";
import { workflowRoute } from "@mastra/ai-sdk";
import type { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import type { AnyWorkflow } from "@mastra/core/workflows";
import { pipeUIMessageStreamToResponse } from "ai";
import express from "express";
import type { Pool } from "pg";

import {
  buildAgents,
  FALLBACK_AGENT_ID,
  type BuiltAgents,
  type MastraOutputProcessorFactory,
} from "./agents.ts";
import { fetchChart } from "./chart.ts";
import { agentChatRoutes } from "./chat.ts";
import {
  attributedUserId,
  executionContextUserId,
  MASTRA_CONFIG_SCHEMA,
  type MastraPluginConfig,
} from "./config.ts";
import {
  chartFetchDefaults,
  feedbackWriteDefaults,
  genieConversationReadDefaults,
  genieConversationWriteDefaults,
  genieSuggestionDefaults,
  modelCatalogueDefaults,
  statementDataDefaults,
} from "./defaults.ts";
import { resolveFeedbackMode } from "./feedback-mode.ts";
import { resolveFollowUpSuggestionsConfig } from "./follow-up-suggestions.ts";
import {
  deleteGenieThread,
  deleteGenieThreadMessage,
  genieChatStream,
  listGenieThreadMessages,
  listGenieThreads,
  type GenieChatSpace,
} from "./genie-chat.ts";
import { collectSpaceSuggestions, resolveGenieSpaces, type GenieSpaceConfig } from "./genie.ts";
import {
  requestUserId,
  resolveIdentityMode,
  useServicePrincipal,
  type MastraIdentityMode,
} from "./identity.ts";
import { buildMcpServer, type ResolvedMcp } from "./mcp.ts";
import { createMemoryBuilder, needsLakebase } from "./memory.ts";
import {
  flushDirectMlflowTracing,
  logFeedback,
  mlflowEnabled,
  mlflowExperimentManagerUrl,
} from "./mlflow.ts";
import { resolveDefaultModelId } from "./model.ts";
import { buildObservability, configureOtelPropagation } from "./observability.ts";
import { provisionRemoteSkills } from "./remote-skills.ts";
import {
  attachRoutePatchMiddleware,
  attachStaleResumeRecovery,
  clearTrustedRequestContext,
  createRequestContext,
  isMastraRequestAllowed,
  MastraServer,
  stampRequestContextUser,
} from "./server.ts";
import { resolveServingConfig } from "./serving.ts";
import { fetchStatementEmbedData, STATEMENT_ROW_CAP } from "./statement.ts";
import { attachChatTurnTelemetry, registerAppMlflowTraceInfoProcessor } from "./telemetry.ts";
import { invalidFields } from "./validation.ts";
import { inlineSkillsFromLocalMounts } from "./workspaces.ts";

const GENIE_MANIFEST = pluginRegistry.data(genie).plugin.manifest;
const LAKEBASE_MANIFEST = pluginRegistry.data(lakebase).plugin.manifest;

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
 *         async tools(plugins) {
 *           return { ...(await plugins.genie?.toolkit()) };
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
  private readonly outputProcessorFactories: MastraOutputProcessorFactory[] = [];
  /** Code-defined workflows registered before the Mastra instance is built. */
  private readonly workflows: Record<string, AnyWorkflow> = {
    ...(this.config.workflows ?? {}),
  };
  /**
   * The optional MCP server exposing this plugin's agents / tools, or
   * `null` when `config.mcp` is disabled (the default). Built in
   * {@link buildAgentAndServer} and registered on the Mastra instance.
   */
  private mcp: ResolvedMcp | null = null;
  /** Resolved feedback destination published to server and browser clients. */
  private resolvedFeedbackMode: feedback.FeedbackMode = "none";
  /**
   * Resolved {@link MastraIdentityMode}: the identity the chat path's Databricks
   * calls run as. Read once at setup so an invalid `genieIdentity` fails the app
   * boot rather than the first request, and so every request agrees.
   */
  private identityMode: MastraIdentityMode = "user";
  override async setup(): Promise<void> {
    // Resolve the identity mode up front so an invalid `genieIdentity` fails the
    // app boot with a clear message rather than 500-ing the first chat request.
    this.identityMode = resolveIdentityMode(this.config.genieIdentity);
    const spaces = resolveGenieSpaces(this.config, this.context);
    this.resolvedFeedbackMode = resolveFeedbackMode(this.config.feedbackMode, {
      genie: this.config.genieAgentMode !== false && Object.keys(spaces).length > 0,
      mlflow: mlflowEnabled(),
    });
    this.config.feedbackMode = this.resolvedFeedbackMode;
    if (this.config.observability !== false) {
      await appkitTelemetry.configureNativeHttpTelemetry({
        // A low-level request without an active semantic span becomes a noisy
        // standalone trace. Requests inside an agent/tool span remain visible.
        outgoingFilter: appkitTelemetry.excludeUnparentedOutgoingHttpTelemetry,
      });
      await registerAppMlflowTraceInfoProcessor();
    }
    // Wait until sibling plugins (e.g. `lakebase`) finish `setup()` so
    // the lakebase pool is valid when storage/memory are enabled.
    this.context?.onLifecycle("setup:complete", async () => {
      configureOtelPropagation();
      this.applyLakebaseAutoDefaults();
      await this.buildAgentAndServer();
    });
  }

  /**
   * The plugin instance agent-backed Databricks calls should run through for
   * `req`, honoring {@link identityMode}. Direct Genie conversation routes use
   * AppKit OBO through `asUser(req)` instead.
   *
   * In `"user"` mode (the default) this is `this.asUser(req)` - AppKit's own
   * proxy that runs every call inside `runInUserContext`, so `getExecutionContext()`
   * returns the caller's OBO client. In `"service-principal"` mode it is `this`
   * unwrapped, so the same methods run in the ambient service context and
   * `getExecutionContext()` returns the app service principal's client - the same
   * "just don't enter `asUser`" pattern AppKit's own service-context calls use. One
   * helper covers the agent-backed workspace calls (serving catalogue, general
   * suggestions, dispatched `ask_genie`, statement fetch, feedback), so the
   * identity decision lives in one place.
   */
  private scopedSelf(req: express.Request): this {
    return useServicePrincipal(this.identityMode, req) ? this : this.asUser(req);
  }

  /**
   * When the `lakebase` plugin is registered, auto-enable `storage`
   * and `memory` unless the caller opted out explicitly (`false` or a
   * custom config object). Run after `setup:complete` so the lookup
   * is reliable: any plugin that registers itself synchronously is
   * already in the registry by the time this fires.
   */
  private applyLakebaseAutoDefaults(): void {
    const hasLakebase = pluginRegistry.instance(this.context, lakebase) !== undefined;
    if (!hasLakebase) return;
    if (this.config.storage === undefined) this.config.storage = true;
    if (this.config.memory === undefined) this.config.memory = true;
  }

  /** Drain Mastra resources, then flush pending direct MLflow traces. */
  async shutdown(): Promise<void> {
    try {
      await this.mastra?.shutdown();
    } finally {
      try {
        await flushDirectMlflowTracing();
      } catch (err) {
        this.logger.warn("error flushing direct MLflow traces", {
          error: errorUtils.toError(err),
        });
      }
    }
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
      /**
       * Register an output-processor factory before agents are built.
       *
       * Deferred sibling plugins use this generic extension point without
       * adding provider-specific behavior to the Mastra plugin.
       */
      registerOutputProcessor: (factory: MastraOutputProcessorFactory): void => {
        if (this.built) {
          throw new Error("Mastra output processors must be registered before agents are built");
        }
        this.outputProcessorFactories.push(factory);
      },
      /** Register a workflow before the hosted Mastra instance is built. */
      registerWorkflow: (key: string, workflow: AnyWorkflow): void => {
        if (this.mastra) {
          throw new Error("Mastra workflows must be registered before the instance is built");
        }
        if (this.workflows[key]) {
          throw new Error(`Mastra workflow key "${key}" is already registered`);
        }
        this.workflows[key] = workflow;
      },
      /** Registered workflow keys in insertion order. */
      listWorkflows: (): string[] => Object.keys(this.workflows),
      /** Underlying Mastra instance for advanced use (custom routes etc.). */
      getMastra: () => this.mastra,
      /**
       * Build the `RequestContext` an agent turn driven from OUTSIDE this
       * plugin's routes needs, such as another plugin's endpoint or a scheduled
       * job.
       *
       * Mastra's user-scoped tools - `ask_genie` most visibly - read the AppKit
       * user off the request context, which only the HTTP middleware stamps.
       * Calling `agent.generate` with a raw prompt therefore answers "the data
       * source is unreachable" where the chat routes answer with real data.
       * Passing this as `requestContext` closes that gap, so an out-of-band turn
       * has exactly the capabilities a chat turn has.
       *
       * Must be called INSIDE an `asUser(req)` scope to inherit the caller's
       * OBO identity; outside one it resolves to the service principal.
       */
      createRequestContext: (
        options: { threadId?: string; resourceId?: string; requestId?: string } = {},
      ): Promise<RequestContext> => createRequestContext(options),
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
        modelCatalog.clearServingEndpointsCache(host),
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
    const followUps = resolveFollowUpSuggestionsConfig(this.config.followUpSuggestions);
    const config: MastraClientConfig = {
      basePath: this.basePath,
      defaultAgent: this.built?.defaultAgentId ?? FALLBACK_AGENT_ID,
      agents: Object.keys(this.built?.agents ?? {}),
      feedbackMode: this.feedbackMode(),
      backgroundTurns: this.config.backgroundTurns !== false,
      followUpSuggestions: followUps?.mode ?? "none",
      followUpSuggestionLimit: followUps?.limit ?? 3,
      // In `service-principal` mode the chat works for any caller who can open
      // the app, so a UI that hides chat behind an OBO-token probe should show
      // it regardless. `"user"` mode keeps the OBO-gated behavior.
      chatAlwaysAvailable: this.identityMode === "service-principal",
    };
    return config as unknown as Record<string, unknown>;
  }

  /** Resolve the only feedback destination exposed for this plugin mode. */
  private feedbackMode(): feedback.FeedbackMode {
    return this.resolvedFeedbackMode;
  }

  override injectRoutes(router: IAppRouter): void {
    this.registerMcpRoutes(router);
    this.registerModelRoutes(router);
    this.registerEmbedRoutes(router);
    this.registerSuggestionRoutes(router);
    this.registerGenieChatRoutes(router);
    this.registerFeedbackRoutes(router);
    this.registerMlflowExperimentRoute(router);
    this.registerAgentRoutes(router);
  }

  /** Register URL aliases for Mastra's MCP transports. */
  private registerMcpRoutes(router: IAppRouter): void {
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
  }

  /** Register model catalogue and per-agent default-model routes. */
  private registerModelRoutes(router: IAppRouter): void {
    // `GET /models` exposes the cached endpoint list so clients can
    // populate model pickers, validate `?model=` choices, etc. Must
    // be registered before the catch-all that forwards everything to
    // the Mastra subapp.
    this.route(router, {
      name: "models",
      method: "get",
      path: routes.MASTRA_ROUTES.models,
      handler: async (req, res) => {
        const result = await this.scopedSelf(req).listModelsResult();
        if (!result.ok) {
          this.sendFailure(res, result, "models", MODEL_CATALOGUE_FAILED_MESSAGE);
          return;
        }
        res.json({ endpoints: result.data });
      },
    });

    // `GET /default-model` (and `/default-model/:agentId`) reports what an
    // unpinned turn will use. A configured string is returned directly; an
    // automatic default resolves the highest-ranked currently available GPT
    // (or general chat fallback) from the same OBO-scoped live catalogue as
    // `/models`; a custom dynamic resolver remains null because it is call-time
    // application code.
    const handleDefaultModel = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      const requested = stringUtils.firstNonEmpty(req.params.agentId);
      if (requested !== null && !this.built?.agents[requested]) {
        res.status(404).json({ error: this.unknownAgentMessage(requested) });
        return;
      }
      const agentId = requested ?? this.built?.defaultAgentId ?? FALLBACK_AGENT_ID;
      const intent = this.built?.defaultModels[agentId];
      let model: string | null = null;
      if (intent?.kind === "configured") {
        model = intent.model;
      } else if (intent?.kind === "auto") {
        const result = await this.scopedSelf(req).listModelsResult();
        if (!result.ok) {
          this.sendFailure(res, result, "default-model", MODEL_CATALOGUE_FAILED_MESSAGE);
          return;
        }
        if (result.data.length > 0) {
          model = resolveDefaultModelId(this.config, result.data);
        }
      }
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
  }

  /** Register the generic chart and statement embed resolver. */
  private registerEmbedRoutes(router: IAppRouter): void {
    // `GET /embed/:type/:id` is the single resolver for every embed
    // marker the agent emits in prose (`[chart:<id>]`,
    // `[data:<id>]`, ...). `:type` selects a resolver from the
    // registry below; `:id` is that resolver's lookup key. The marker grammar
    // is type-agnostic; the client still chooses how each registered type
    // renders.
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
    //   - `data`: one Statement Execution fetch under `genieIdentity`.
    //   - `visualization`: the same payload under mandatory OBO identity for
    //     direct Genie chat, whose conversations belong to the signed-in user.
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
        return this.scopedSelf(req).fetchChartEntry(req, id, {
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          signal,
        });
      },
      data: (req, id, signal) => {
        const limit = parseStatementLimit(req.query.limit);
        return this.scopedSelf(req).fetchStatement(id, {
          ...(limit !== undefined ? { limit } : {}),
          signal,
        });
      },
      visualization: (req, id, signal) => {
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
        const type = stringUtils.firstNonEmpty(req.params.type) ?? "";
        const id = stringUtils.firstNonEmpty(req.params.id);
        const resolve = embedResolvers[type];
        if (!resolve) {
          this.logger.warn("embed:unsupported", {
            status: 404,
            type,
            id,
            method: req.method,
            path: req.path,
          });
          res.status(404).json({ error: `unsupported embed type: ${type}` });
          return;
        }
        if (!id) {
          this.logger.warn("embed:invalid", {
            status: 400,
            type,
            method: req.method,
            path: req.path,
            error: "id is required",
          });
          res.status(400).json({ error: "id is required" });
          return;
        }
        // Bridge response close onto an AbortSignal so a client disconnect
        // releases long-poll and workspace calls immediately.
        const controller = new AbortController();
        res.on("close", () => controller.abort());
        const result = await resolve(req, id, controller.signal);
        if (controller.signal.aborted) return;
        if (!result.ok) {
          this.sendFailure(res, result, `embed:${type}`, `Could not resolve the ${type} embed`);
          return;
        }
        if (result.data === undefined) {
          // A cache miss is security-deliberately ambiguous: unknown, expired,
          // or owned by another identity all map to the same 404. Log the
          // opaque id and those possible causes so a fabricated marker is
          // diagnosable from the server without disclosing which cause applied.
          this.logger.warn(`embed:${type}:not-found`, {
            status: 404,
            type,
            id,
            method: req.method,
            path: req.path,
            reason: "unknown, expired, or owned by another identity",
          });
          res.status(404).json({ error: `${type} not found` });
          return;
        }
        res.json(result.data);
      },
    });
  }

  /** Register default and agent-qualified suggestion routes. */
  private registerSuggestionRoutes(router: IAppRouter): void {
    // `GET /suggestions` (and `/suggestions/:agentId`) returns the
    // curated starter questions for the agent's Genie space(s) - the
    // author-configured `sample_questions`, surfaced as one-tap
    // prompts on the chat empty state. Returns `{ questions: [] }`
    // when no Genie space is wired so the client renders a bare
    // empty state (no built-in example prompts). The `:agentId`
    // segment is accepted for URL symmetry with the chat / history
    // routes; Genie spaces are resolved per-plugin, not per-agent,
    // so it doesn't change the result. The space lookup uses the configured
    // agent-backed identity.
    const handleSuggestions = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      const result = await this.scopedSelf(req).fetchSuggestions(controller.signal);
      if (controller.signal.aborted) return;
      if (!result.ok) {
        // Suggestions are a non-critical enhancement; a lookup failure should
        // leave the chat usable with a bare empty state rather than surfacing
        // the upstream status. Log and degrade.
        this.logger.warn("suggestions:error", {
          status: result.status,
          error: errorUtils.toError(result.message),
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
  }

  /**
   * Register the direct Genie chat routes. Each route is scoped to one Genie
   * space alias and sits directly on the Genie APIs under AppKit's OBO user
   * context: conversations are threads, Genie messages are history, and a turn
   * streams the same AI SDK chunks as an agent's `ask_genie` call. Nothing is
   * written to Mastra Memory.
   */
  private registerGenieChatRoutes(router: IAppRouter): void {
    const path = (...parts: string[]) => routes.genieRoutePath(":alias", ...parts);
    const { chat: chatSegment, messages, suggestions, threads } = routes.MASTRA_ROUTES;
    /** Resolve the route's alias, answering 404 when no such space is configured. */
    const spaceFor = (req: express.Request, res: express.Response): GenieChatSpace | undefined => {
      const alias = stringUtils.firstNonEmpty(req.params.alias) ?? "";
      const configured = resolveGenieSpaces(this.config, this.context)[alias];
      if (configured) return { alias, spaceId: configured.spaceId };
      res.status(404).json({ error: `Unknown Genie space alias "${alias}"` });
      return undefined;
    };
    /** Bridge the connection `close` event onto an abort signal. */
    const closeSignal = (res: express.Response): AbortSignal => {
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      return controller.signal;
    };

    this.route(router, {
      name: "genieChat",
      method: "post",
      path: path(chatSegment),
      handler: async (req, res) => {
        const space = spaceFor(req, res);
        if (!space) return;
        const parsed = wire.GenieChatRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "question is required", fields: invalidFields(parsed.error) });
          return;
        }
        await this.asUser(req).streamGenieChat(res, space, parsed.data, closeSignal(res));
      },
    });
    this.route(router, {
      name: "genieThreads",
      method: "get",
      path: path(threads),
      handler: async (req, res) => {
        const space = spaceFor(req, res);
        if (!space) return;
        const result = await this.asUser(req).genieConversationRead((client) =>
          listGenieThreads(client, space),
        );
        if (!result.ok) {
          this.sendFailure(res, result, "genie-threads", "Could not list Genie conversations");
          return;
        }
        res.json({ threads: result.data });
      },
    });
    this.route(router, {
      name: "genieThreadMessages",
      method: "get",
      path: path(threads, ":threadId", messages),
      handler: async (req, res) => {
        const space = spaceFor(req, res);
        if (!space) return;
        const threadId = stringUtils.firstNonEmpty(req.params.threadId) ?? "";
        const result = await this.asUser(req).genieConversationRead((client) =>
          listGenieThreadMessages({
            client,
            space,
            conversationId: threadId,
          }),
        );
        if (!result.ok) {
          this.sendFailure(res, result, "genie-messages", "Could not load the Genie conversation");
          return;
        }
        res.json({ messages: result.data });
      },
    });
    this.route(router, {
      name: "genieThreadDelete",
      method: "delete",
      path: path(threads, ":threadId"),
      handler: async (req, res) => {
        const space = spaceFor(req, res);
        if (!space) return;
        const threadId = stringUtils.firstNonEmpty(req.params.threadId) ?? "";
        const result = await this.asUser(req).genieConversationWrite((client) =>
          deleteGenieThread(client, space, threadId),
        );
        if (!result.ok) {
          this.sendFailure(
            res,
            result,
            "genie-thread-delete",
            "Could not delete the Genie conversation",
          );
          return;
        }
        res.status(204).end();
      },
    });
    this.route(router, {
      name: "genieThreadMessageDelete",
      method: "delete",
      path: path(threads, ":threadId", messages, ":messageId"),
      handler: async (req, res) => {
        const space = spaceFor(req, res);
        if (!space) return;
        const threadId = stringUtils.firstNonEmpty(req.params.threadId) ?? "";
        const messageId = stringUtils.firstNonEmpty(req.params.messageId) ?? "";
        const result = await this.asUser(req).genieConversationWrite((client) =>
          deleteGenieThreadMessage(client, space, threadId, messageId),
        );
        if (!result.ok) {
          this.sendFailure(
            res,
            result,
            "genie-message-delete",
            "Could not delete the Genie message",
          );
          return;
        }
        res.status(204).end();
      },
    });
    this.route(router, {
      name: "genieSuggestions",
      method: "get",
      path: path(suggestions),
      handler: async (req, res) => {
        const space = spaceFor(req, res);
        if (!space) return;
        const result = await this.asUser(req).fetchSuggestions(undefined, {
          [space.alias]: { spaceId: space.spaceId },
        });
        res.json({ questions: result.ok ? result.data : [] });
      },
    });
  }

  /**
   * Stream one direct Genie turn to `res` under AppKit's OBO user context.
   * Direct conversations cannot use the shared service principal because Genie
   * owns them under the Databricks caller.
   */
  private async streamGenieChat(
    res: express.Response,
    space: GenieChatSpace,
    request: GenieChatRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const context = getExecutionContext();
    const client = context.client;
    const requestContext = new RequestContext<unknown>(
      Object.entries(request.requestContext ?? {}),
    );
    clearTrustedRequestContext(requestContext);
    const applicationContext = requestContext.toJSON();
    await stampRequestContextUser(requestContext);
    const memory = await this.built?.agents[this.built.defaultAgentId]?.getMemory({
      requestContext,
    });
    await pipeUIMessageStreamToResponse({
      response: res,
      stream: genieChatStream({
        client,
        space,
        request: {
          question: request.question,
          ...(request.conversationId ? { conversationId: request.conversationId } : {}),
          ...(Object.keys(applicationContext).length > 0
            ? { requestContext: applicationContext }
            : {}),
        },
        ...(memory ? { memory } : {}),
        requestContext,
        signal,
      }),
    });
  }

  /** Run one Genie conversation read under the active request identity. */
  private genieConversationRead<T>(
    read: (client: ReturnType<typeof getExecutionContext>["client"]) => Promise<T>,
  ): Promise<ExecutionResult<T>> {
    const client = getExecutionContext().client;
    return this.execute(() => read(client), genieConversationReadDefaults);
  }

  /** Run one Genie conversation write under the active request identity. */
  private genieConversationWrite(
    write: (client: ReturnType<typeof getExecutionContext>["client"]) => Promise<void>,
  ): Promise<ExecutionResult<void>> {
    const client = getExecutionContext().client;
    return this.execute(() => write(client), genieConversationWriteDefaults);
  }

  /** Register the single feedback destination selected by plugin mode. */
  private registerFeedbackRoutes(router: IAppRouter): void {
    this.route(router, {
      name: "feedback",
      method: "post",
      path: routes.MASTRA_ROUTES.feedback,
      handler: async (req, res) => {
        const mode = this.feedbackMode();
        if (mode === "none") {
          res.status(404).json({ ok: false });
          return;
        }
        const parsed = feedback.MastraFeedbackRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          // A Zod issue string quotes the received body back, so only the
          // offending field names travel; the full issue list is logged.
          this.logger.warn("feedback:invalid", { error: parsed.error });
          res.status(400).json({
            ok: false,
            error: INVALID_FEEDBACK_MESSAGE,
            fields: invalidFields(parsed.error),
          });
          return;
        }
        if (parsed.data.mode !== mode) {
          res.status(400).json({ ok: false, error: INVALID_FEEDBACK_MESSAGE });
          return;
        }
        if (parsed.data.mode === "genie") {
          const result = await this.scopedSelf(req).sendGenieFeedback(parsed.data);
          if (!result.ok) {
            this.sendFailure(res, result, "genie-feedback", "Feedback could not be recorded");
            return;
          }
          res.json({ ok: true });
          return;
        }
        const result = await this.scopedSelf(req).logFeedback(parsed.data);
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
  }

  /** Register the best-effort per-viewer MLflow experiment debug link. */
  private registerMlflowExperimentRoute(router: IAppRouter): void {
    this.route(router, {
      name: "mlflowExperiment",
      method: "get",
      path: routes.MASTRA_ROUTES.mlflowExperiment,
      handler: async (req, res) => {
        if (this.feedbackMode() !== "mlflow") {
          res.json({ url: null });
          return;
        }
        const result = await this.scopedSelf(req).fetchMlflowExperimentUrl();
        res.json({ url: result.ok ? (result.data ?? null) : null });
      },
    });
  }

  /** Register the gated Mastra catch-all after every explicit route. */
  private registerAgentRoutes(router: IAppRouter): void {
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
      // an OBO token makes `scopedSelf` return the proxy. `dispatchMastra`
      // is a plain method (its `.bind` is the normal one) and invokes
      // `this.mastraApp` off the real target, keeping the OBO scope active.
      return this.scopedSelf(req).dispatchMastra(req, res, next);
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
      error: errorUtils.toError(result.message),
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
   * `only` narrows the lookup to the given spaces (the direct Genie chat
   * passes its own). Returns `[]` when no Genie space is configured so the
   * client shows a bare empty state instead of built-in example prompts.
   */
  private async fetchSuggestions(
    signal?: AbortSignal,
    only?: Record<string, GenieSpaceConfig>,
  ): Promise<ExecutionResult<string[]>> {
    const spaces = only ?? resolveGenieSpaces(this.config, this.context);
    if (Object.keys(spaces).length === 0) return { ok: true, data: [] };
    const client = getExecutionContext().client;
    return this.execute((executeSignal) => {
      const combined = asyncUtils.combineAbortSignals(signal, executeSignal);
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
    feedback: feedback.MlflowFeedbackRequest,
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

  /** Send Agent Mode rating and comment directly to the originating Genie message. */
  private sendGenieFeedback(input: feedback.GenieFeedbackRequest): Promise<ExecutionResult<void>> {
    const client = getExecutionContext().client;
    return this.execute(
      (signal) =>
        sendGenieMessageFeedback(
          {
            space_id: input.spaceId,
            conversation_id: input.conversationId,
            message_id: input.messageId,
            rating: input.rating,
            ...(input.comment ? { comment: input.comment } : {}),
          },
          {
            workspaceClient: client,
            ...(signal ? { context: signal } : {}),
          },
        ),
      feedbackWriteDefaults,
    );
  }

  /**
   * Resolve an experiment link under the active request identity. The helper
   * returns no URL unless the viewer has effective `CAN_MANAGE` permission.
   */
  private async fetchMlflowExperimentUrl(): Promise<ExecutionResult<string | undefined>> {
    const client = getExecutionContext().client;
    return this.execute(() => mlflowExperimentManagerUrl(client), feedbackWriteDefaults);
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
        const combined = asyncUtils.combineAbortSignals(options.signal, executeSignal);
        try {
          const { data, visualization } = await fetchStatementEmbedData(client, statementId, {
            limit,
            ...(combined ? { signal: combined } : {}),
          });
          return {
            columns: data.columns,
            rows: data.rows,
            rowCount: data.rowCount,
            truncated: data.rows.length < data.rowCount,
            visualization,
          };
        } catch (err) {
          // The Databricks SDK throws on 404; surface as `undefined`
          // so the route maps to a clean HTTP 404 instead of a 500.
          if (errorUtils.errorContext(err).notAccessible) return undefined;
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
   *
   * The key is built from {@link attributedUserId} - the same rule that named
   * the identity the chart was written under - rather than from the ambient
   * execution context alone. In `service-principal` mode the ambient context is
   * the SP for every caller, so keying off it alone missed every chart the
   * turn had written under the forwarded user and the UI showed each one as
   * expired. `req` is read inside the method, not at the call site, so the
   * execution context is the scoped one.
   */
  private async fetchChartEntry(
    req: express.Request,
    chartId: string,
    options: { timeoutMs?: number; signal: AbortSignal },
  ): Promise<ExecutionResult<Chart | undefined>> {
    const userKey = attributedUserId(getExecutionContext(), requestUserId(req));
    return this.execute(
      (executeSignal) =>
        fetchChart(chartId, {
          userKey,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          signal: asyncUtils.combineAbortSignals(options.signal, executeSignal) ?? options.signal,
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
      const context = getExecutionContext();
      const client = context.client;
      const cacheIdentity = executionContextUserId(context);
      const host = (await client.config.getHost()).toString();
      const serving = resolveServingConfig(this.config);
      return modelCatalog.listServingEndpoints(client, host, {
        ttlMs: serving.ttlMs,
        cacheIdentity,
      });
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
      error: errorUtils.toError(result.message),
    });
    throw new ExecutionError(MODEL_CATALOGUE_FAILED_MESSAGE);
  }

  private async buildAgentAndServer(): Promise<void> {
    const memoryPool = needsLakebase(this.config)
      ? (lakebaseResolver.captureServicePrincipalPool(
          pluginRegistry.require(this.context, lakebase, this.config).exports().pool,
        ) as Pool)
      : undefined;
    const memoryBuilder = createMemoryBuilder(this.config, memoryPool);

    // Build every agent declared in `config.agents` (or the built-in
    // fallback when none are declared). Each agent's `model` resolves
    // workspace URL + bearer at call time so concurrent requests get
    // distinct user identities; the `asUser(req)` scope around
    // `handleChat` is what lets `getExecutionContext()` return the
    // right user inside the resolver.
    // Materialize any remote Agent-Skill sources ONCE at startup. Runs
    // outside a request scope, so it uses the app service principal's client
    // and defaults to the shared workspace Assistant skills tree; a source
    // backed by local or memory storage is converted into native agent-level
    // skills; Databricks workspace directories remain search-discovered.
    const provisioned = await provisionRemoteSkills(this.config.remoteSkills);
    if (provisioned.skillNames.length > 0) {
      this.logger.info("remote skills configured", {
        skills: provisioned.skillNames,
        databricksBasePath: provisioned.databricksBasePath,
        localSkillMounts: provisioned.localSkillMounts.length,
        standardSkillMounts: provisioned.standardSkillMounts.length,
      });
    }

    const localSkillMounts = [
      ...(this.config.localSkillMounts ?? []),
      ...provisioned.localSkillMounts,
    ];
    const standardSkills = await inlineSkillsFromLocalMounts([
      ...(this.config.localSkillMounts ?? []),
      ...provisioned.standardSkillMounts,
    ]);
    this.built = await buildAgents({
      config: this.config,
      context: this.context,
      memoryBuilder,
      outputProcessorFactories: this.outputProcessorFactories,
      log: this.logger,
      extraSkillMounts: localSkillMounts,
      standardSkills,
      excludedWorkspaceSkillNames: provisioned.skillNames,
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
      tracerProvider: await appkitTelemetry.deferredNativeTracerProvider(),
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
      ...(Object.keys(this.workflows).length > 0 ? { workflows: this.workflows } : {}),
      ...(instanceStorage ? { storage: instanceStorage } : {}),
      ...(observability ? { observability } : {}),
      ...(this.mcp ? { mcpServers: { [this.mcp.serverId]: this.mcp.server } } : {}),
    });
    this.mastraApp = express();
    attachRoutePatchMiddleware(this.mastraApp);
    // Stamp chat request/response onto the HTTP root span so MLflow's
    // UC `*_trace_unified` view can surface them (Mastra's own
    // `mastra.agent_run.*` attributes sit on a child span the view
    // never reads). Must run before `MastraServer.init` so the layer
    // sits ahead of the agent routes.
    attachChatTurnTelemetry(this.mastraApp, {
      identity: (request) =>
        useServicePrincipal(this.identityMode, request) ? "service-principal" : "obo",
    });
    this.mastraServer = new MastraServer(this.config, {
      app: this.mastraApp,
      mastra: this.mastra,
      prefix: "",
      customApiRoutes: [
        ...agentChatRoutes(this.config),
        workflowRoute({
          path: "/route/workflows/:workflowId/stream",
          version: "v7",
        }),
      ],
    });
    await this.mastraServer.init();
    attachStaleResumeRecovery(this.mastraApp);
    this.logger.info("ready", {
      agents: Object.keys(this.built.agents),
      workflows: Object.keys(this.workflows),
      defaultAgent: this.built.defaultAgentId,
      backgroundTurns: this.config.backgroundTurns !== false,
      apiAccess: this.config.apiAccess ?? "scoped",
      mcp: this.mcp ? `${this.basePath}${this.mcp.httpPath}` : "off",
      lakebase: memoryPool !== undefined,
      feedback: this.feedbackMode(),
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
  const n = object.toNumber(v);
  if (n === undefined || n <= 0) return undefined;
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
  const n = object.toNumber(v);
  if (n === undefined || n < 0) return undefined;
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
 *           async tools(plugins) {
 *             return { ...(await plugins.genie?.toolkit()) };
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
