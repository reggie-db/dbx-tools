/**
 * Plugin configuration types and shared `RequestContext` keys.
 *
 * Owns the typed {@link MastraPluginConfig} (the plugin's slice of AppKit
 * config) and {@link MASTRA_CONFIG_SCHEMA}, the JSON Schema the manifest
 * publishes for it so scaffolding tools and agents can read the option set.
 *
 * Precedence per field is explicit plugin config, then the environment
 * variable named on the field, then a built-in default.
 *
 * Kept in a leaf module so `plugin.ts`, `server.ts`, `model.ts`, and
 * `memory.ts` can import them without creating a cycle.
 *
 * @module
 */

import { getExecutionContext, type BasePluginConfig, type ConfigSchema } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";
import type { BrandContext } from "@dbx-tools/shared-core";
import type { AgentConfig } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "@mastra/core/request-context";
import type { PgVectorConfig, PostgresStoreConfig } from "@mastra/pg";

import type { MastraAgentDefinition, MastraTools } from "./agents.ts";
import type { GenieSpacesConfig } from "./genie.ts";
import type { MastraIdentityMode } from "./identity.ts";

/**
 * `RequestContext` key under which {@link MastraServer} stores the
 * resolved AppKit user. `model.ts` reads it to mint user-scoped
 * Databricks tokens.
 */
export const MASTRA_USER_KEY = "mastra__user";

/**
 * `RequestContext` keys for AppKit user metadata stamped by
 * {@link MastraServer}. Surfaced as trace metadata via
 * {@link TRACE_REQUEST_CONTEXT_KEYS} so traces are filterable by who
 * issued the request without leaking the full user object.
 */
export const MASTRA_USER_NAME_KEY = "mastra__userName";
export const MASTRA_USER_EMAIL_KEY = "mastra__userEmail";

/**
 * `RequestContext` key for the per-HTTP-request id stamped by
 * {@link MastraServer}. Reads `X-Request-Id` from the incoming
 * headers when present (so an upstream load balancer / API gateway
 * can keep its trace correlation), falls back to a freshly minted
 * UUID. Echoed back on the response and surfaced on every span via
 * {@link TRACE_REQUEST_CONTEXT_KEYS} so logs and traces share a
 * join key.
 */
export const MASTRA_REQUEST_ID_KEY = "mastra__requestId";

/**
 * `RequestContext` key for OAuth scopes parsed from the forwarded
 * access token by {@link MastraServer.configureRequestContextScopes}.
 * Workspace mounts that touch Databricks workspace files require
 * `workspace` or `all-apis` in this list.
 */
export const MASTRA_SCOPES_KEY = "mastra__scopes";

/**
 * Canonical list of `RequestContext` keys we want Mastra to extract
 * as metadata on every observability span (agent runs, model calls,
 * tool invocations, workflow steps).
 *
 * Mirrors {@link https://mastra.ai/docs/observability/tracing/overview#automatic-metadata-from-requestcontext}:
 * passed verbatim into `Observability.configs[*].requestContextKeys`,
 * so any key listed here is read from `RequestContext` at trace
 * start and attached as scalar span metadata. Keep the set to plain
 * scalars - never include {@link MASTRA_USER_KEY} (it carries the
 * full AppKit execution context with a `WorkspaceClient` reference).
 *
 * Order is purely cosmetic; Mastra de-dupes internally.
 */
export const TRACE_REQUEST_CONTEXT_KEYS: readonly string[] = [
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  MASTRA_REQUEST_ID_KEY,
  MASTRA_USER_NAME_KEY,
  MASTRA_USER_EMAIL_KEY,
  // Model override key is owned by `serving.ts`; spelled inline here
  // so this module stays leaf-level (no cycles with `serving.ts`).
  "mastra__model_override",
];

/** AppKit execution context plus the canonical user id. */
export interface User {
  id: string;
  executionContext: appkit.ExecutionContextLike;
}

/**
 * Canonical identity for an AppKit execution context: the OBO user id on a
 * user-scoped call, the service principal id otherwise.
 */
export function executionContextUserId(context: appkit.ExecutionContextLike): string {
  return "userId" in context ? context.userId : context.serviceUserId;
}

/**
 * Who a turn is ATTRIBUTED to, which is not always whose Databricks credential
 * runs it. An OBO context's own user id is authoritative. Under the service
 * principal, every caller shares one credential, so the forwarded user id is
 * what keeps memory threads and per-user cache namespaces distinct; the service
 * principal id is the floor when no user was forwarded.
 *
 * This rule has to be identical everywhere a cache key is built, so both the
 * write side (the `RequestContext` user stamped by `stampRequestContextUser`)
 * and the read side (the plugin's own AppKit routes, which have a request but
 * no `RequestContext`) derive their key from this one function. When the two
 * disagreed, a chart written under the forwarded user id was read back under
 * the service principal id and the embed route answered 404, which the chat UI
 * renders as an expired chart.
 */
export function attributedUserId(
  executionContext: appkit.ExecutionContextLike,
  forwardedUserId?: string,
): string {
  if ("isUserContext" in executionContext) return executionContextUserId(executionContext);
  return forwardedUserId ?? executionContextUserId(executionContext);
}

/**
 * Identity every per-user cache entry is namespaced under, so an OBO result
 * cannot be read back by another caller.
 *
 * Prefers the {@link User} that {@link MastraServer} stamps on the request
 * context, whose id already follows {@link attributedUserId}. The MCP transport
 * routes do not thread that context into tool execution, so those fall back to
 * the ambient execution context (the active OBO scope, or the service
 * principal). A caller holding an express request should build its key from
 * {@link attributedUserId} instead, so the forwarded user is not lost.
 */
export function resolveUserKey(requestContext?: RequestContext): string {
  const user = requestContext?.get(MASTRA_USER_KEY) as User | undefined;
  return user?.id ?? executionContextUserId(getExecutionContext());
}

/** PgVector config with an optional Mastra store id. */
export type MastraMemoryConfig = PgVectorConfig & {
  id?: string;
};

/**
 * Fine-grained control for the optional MCP server exposure
 * ({@link MastraPluginConfig.mcp}). Every field is optional; the object
 * form only needs to set what differs from the defaults.
 */
export interface MastraMcpConfig {
  /**
   * Server id used in the route path (`/mcp/<serverId>/...`) and as the
   * MCP registry id. Defaults to the plugin's registered name.
   */
  serverId?: string;
  /** Display name advertised over MCP. Defaults to `"<displayName> MCP"`. */
  name?: string;
  /** Semantic version advertised over MCP. Defaults to `"1.0.0"`. */
  version?: string;
  /** Optional human-readable description advertised over MCP. */
  description?: string;
  /**
   * Expose every registered agent as an `ask_<agentId>` MCP tool.
   * Defaults to `true` - this is the "leverage the Mastra agents over
   * MCP" behavior most callers want.
   */
  agents?: boolean;
  /**
   * Also expose the plugin's ambient tools (the built-in `render_data`
   * plus anything in `config.tools`) as MCP tools. Defaults to `false`:
   * the ambient tools assume an in-process chat turn (they publish
   * writer events the chat UI consumes), so they aren't useful to a
   * standalone MCP client. Turn this on only when those tools are safe
   * to call out-of-band.
   */
  tools?: boolean;
  /**
   * Extra tools to expose over MCP beyond the agent / ambient sets.
   * Use this for tools written specifically for MCP consumers.
   */
  extraTools?: MastraTools;
}

/** Configuration accepted by the Mastra AppKit plugin. */
export interface MastraPluginConfig extends BasePluginConfig {
  /** Mastra OpenAI-compatible provider id. Defaults to `"databricks"`; no env fallback. */
  providerId?: string;
  /**
   * PostgresStore for Mastra threads/messages. `true` reuses the
   * `lakebase` plugin's pool; an object opens a dedicated store.
   */
  storage?: boolean | PostgresStoreConfig;
  /**
   * PgVector store for Mastra memory recall. `true` reuses the
   * `lakebase` plugin's pool; an object opens a dedicated store.
   */
  memory?: boolean | MastraMemoryConfig;
  /**
   * Code-defined agents. Accepts three shapes for convenience:
   *
   * - **Record**: `{ analyst: def, helper: def }` - keys become the
   *   registered ids and the first key is the default.
   * - **Single definition**: `def` - registered under
   *   `slugify(def.name)` (or `"default"` when `name` is omitted) and
   *   automatically marked as the default agent.
   * - **Array**: `[def1, def2]` - each registered under
   *   `slugify(def.name)` (or `agent_${i}` when `name` is omitted);
   *   the first entry is the default.
   *
   * Each entry becomes a Mastra `Agent` reachable at
   * `/api/<plugin>/route/chat/<id>` (the chat route also matches
   * `:agentId`). When `agents` is omitted entirely, the plugin
   * registers a single built-in `default` analyst so the bare
   * `mastra()` call still mounts a working chat endpoint.
   *
   * @example Single-agent shorthand
   * ```ts
   * mastra({
   *   agents: createAgent({ instructions: "..." }),
   * });
   * ```
   *
   * @example Array
   * ```ts
   * mastra({
   *   agents: [
   *     createAgent({ name: "analyst", instructions: "..." }),
   *     createAgent({ name: "helper", instructions: "..." }),
   *   ],
   * });
   * ```
   *
   * @example Record (explicit ids)
   * ```ts
   * mastra({
   *   agents: {
   *     analyst: createAgent({ instructions: "..." }),
   *     helper: createAgent({ instructions: "..." }),
   *   },
   *   defaultAgent: "analyst",
   * });
   * ```
   */
  agents?: Record<string, MastraAgentDefinition> | MastraAgentDefinition | MastraAgentDefinition[];
  /**
   * Ambient tools spread into every registered agent's tools record;
   * per-agent tools win on key collision. Use for a small shared
   * library; for per-agent tools set `agents[id].tools` instead.
   */
  tools?: MastraTools;
  /**
   * Agent id used when the client doesn't specify one (the bare,
   * un-suffixed history / suggestions routes resolve to it).
   * Defaults to the first key in `agents` (or `"default"` when
   * `agents` is omitted). Must match an id in `agents` when both are
   * set; a mismatch throws at setup with the available candidates.
   */
  defaultAgent?: string;
  /**
   * Plugin-level default model applied to every agent that omits its
   * own `model`. Mirrors AppKit's `agents({ defaultModel })`.
   *
   * - `string`: shorthand for "use the OBO auto-resolver but swap the
   *   `modelId`" (e.g. `"databricks-claude-sonnet-4-6"`).
   * - Any other Mastra `DynamicArgument<MastraModelConfig>`: passed
   *   through verbatim. Use this when you need full control over auth
   *   or `providerId`.
   *
   * Resolution order per agent: `def.model` → `defaultModel` →
   * `DATABRICKS_SERVING_ENDPOINT_NAME` → built-in `/serving-endpoints`
   * resolver.
   */
  defaultModel?: AgentConfig["model"] | string;
  /**
   * Fuzzy-match loose model names (`"claude sonnet"`) against the workspace's
   * Model Serving endpoints. Defaults to `true`; no env fallback.
   *
   * Set `false` to require exact endpoint names everywhere.
   */
  modelFuzzyMatch?: boolean;
  /**
   * Fuse.js score threshold for the fuzzy matcher, 0 (exact) to 1 (anything).
   * Defaults to `0.4`; no env fallback.
   *
   * Lower values reject loose matches; raise it if you have a sprawling
   * endpoint catalogue with similar-looking names.
   */
  modelFuzzyThreshold?: number;
  /**
   * TTL for the in-memory serving-endpoints list cache, in milliseconds.
   * Defaults to 5 minutes; no env fallback.
   *
   * The cache is per workspace host and shared across users; concurrent
   * callers coalesce on a single in-flight fetch.
   */
  modelCacheTtlMs?: number;
  /**
   * Let clients pick the backing endpoint per request. Defaults to `true`;
   * no env fallback.
   *
   * Reads the `X-Mastra-Model` header, the `?model=` query string, or a
   * `model` body field, in that order. Disable when running multi-tenant
   * where untrusted clients shouldn't choose the endpoint.
   */
  modelOverride?: boolean;
  /**
   * Priority-ordered list of endpoint names tried *first* when no
   * agent / plugin / env / request-override model id is set, ahead of
   * the dynamic score-classified catalogue. The resolver picks the
   * first id that is actually present in the workspace's
   * `/serving-endpoints` listing.
   *
   * When unset, resolution is driven by the live Foundation Model API
   * `quality` / `speed` / `cost` scores: endpoints are classified into
   * chat classes (`classifyEndpoints`) and walked best-first
   * (ChatThinking -> ChatBalanced -> ChatFast), with the small built-in
   * `FALLBACK_MODEL_IDS` list as the floor when the catalogue can't be
   * read. Set this to
   * pin a regulated workspace to an approved subset, or to put custom
   * endpoints in front of the auto-classified catalogue.
   */
  defaultModelFallbacks?: readonly string[];
  /**
   * When `true` (default), every agent gets a built-in input
   * processor that strips `chartId` fields from prior assistant
   * tool-invocation results before they reach the model. This
   * prevents the model from reusing turn-scoped chartIds it sees
   * in memory recall (which would leave `[chart:<id>]` markers
   * pointing at writer events that no longer exist).
   *
   * Set to `false` to opt out - useful if a non-default agent
   * needs full visibility into prior chartIds (e.g. an audit
   * agent reasoning about chart lineage).
   */
  stripStaleCharts?: boolean;
  /**
   * Style guardrails appended to every agent's `instructions` to curb
   * common LLM-isms (em dashes, emojis, sycophantic openers, throwaway
   * closers, excessive hedging).
   *
   * - `undefined` (default): use the built-in
   *   `DEFAULT_STYLE_INSTRUCTIONS` from `agents.ts`.
   * - `string`: replace the default with the supplied block.
   * - `false`: disable entirely (agents see only their bespoke
   *   `instructions`).
   *
   * Appended (not prepended) so the agent's role and rules come first
   * and the style block leans on the model's recency bias.
   */
  styleInstructions?: string | false;
  /**
   * Genie spaces this plugin's agents can delegate to. One Mastra
   * tool is registered per alias (`genie` for the well-known
   * `default` alias, `genie_<alias>` otherwise). Each tool spins
   * up a per-question Genie sub-agent that runs Databricks
   * "agent mode" against the space, broadcasts wire events to the
   * UI, fetches statement rows for non-empty results, and returns
   * a `(string | data | chart)[]` summary the host UI renders
   * inline.
   *
   * Entries accept either a full {@link GenieSpaceConfig} object
   * or a bare `space_id` string when no extras are needed:
   *
   * ```ts
   * mastra({
   *   genieSpaces: {
   *     default: "01ef0d3c0e1b1f4a8d2c3e4f5a6b7c8d",
   *     forecasts: { spaceId: "01ef...", hint: "weekly demand forecasts" },
   *   },
   * });
   * ```
   *
   * Reach the spaces from an agent's `tools(plugins)` callback via
   * `plugins.genie?.toolkit()`; the resulting tools accept
   * `{ content, conversationId? }` and return a hydrated summary.
   *
   * **Fallback discovery** (highest precedence first): if this
   * field is omitted, the Genie agent also picks up spaces from
   * (1) the AppKit `genie({ spaces: { ... } })` plugin instance
   * when registered, and (2) the `DATABRICKS_GENIE_SPACE_ID`
   * env var (registered under the `default` alias). This keeps
   * existing AppKit deployments working without restating the
   * spaces config in two places.
   */
  genieSpaces?: GenieSpacesConfig;
  /**
   * TTL for the in-memory Genie space metadata cache, in
   * milliseconds. Defaults to 5 minutes. The Genie agent calls
   * `client.genie.getSpace(...)` on every cold-start to get the
   * title / description / warehouse id; cached responses skip the
   * round-trip and concurrent callers coalesce on a single
   * in-flight fetch. Drop to a smaller value when analysts are
   * actively editing space metadata and you want changes visible
   * within seconds; raise it to amortise the round-trip when
   * space metadata is effectively frozen.
   *
   * Backed by AppKit's `CacheManager`, so the cache participates
   * in telemetry spans (`cache.getOrExecute`) and benefits from
   * Lakebase persistence when the `lakebase` plugin is wired up.
   */
  genieSpaceCacheTtlMs?: number;
  /**
   * Maximum LLM steps each agent gets per turn. One step = one
   * round-trip to the underlying model (a tool call consumes a
   * step, the final-text reply consumes one too). Applies to
   * every agent registered through {@link MastraPluginConfig.agents}
   * - per-agent overrides aren't surfaced yet because the same
   * ceiling has been sufficient across every workload we've run.
   *
   * Defaults to {@link DEFAULT_AGENT_MAX_STEPS} (25), sized to fit
   * a decomposed Genie turn (grounding + several `ask_genie` calls
   * + `prepare_chart` per dataset + the final-text reply) with
   * headroom for the model to chain a couple of follow-ups before
   * answering. Mastra's own `agent.generate` default of 5 would
   * cut multi-step orchestration off after 2-3 tool calls, so
   * explicitly raising the ceiling here is what lets the
   * agent-mode loop play out.
   *
   * Lower when an unusually slow or expensive model makes long
   * turns unaffordable; raise for exploratory workloads that need
   * to drill deep into a dataset within a single turn.
   */
  agentMaxSteps?: number;
  /**
   * Wire Mastra spans into AppKit's global OTel pipeline via
   * `@mastra/otel-bridge`.
   *
   * - `undefined` (default, auto): on only when
   *   `OTEL_EXPORTER_OTLP_ENDPOINT` or
   *   `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set. When unset, the
   *   bridge is skipped so Mastra does not log
   *   `[OtelBridge] No OTEL span found` on the noop tracer.
   * - `true`: force on even without an OTLP endpoint.
   * - `false`: force off.
   */
  observability?: boolean;
  /**
   * Log user feedback (thumbs up/down + freeform comments) to MLflow as
   * trace assessments, and surface the feedback controls in the chat UI.
   *
   * - `undefined` (default, auto): enabled only when MLflow tracing is
   *   wired - an OTLP exporter endpoint is set and an MLflow experiment
   *   is named (the same signals the observability pipeline needs to
   *   ship traces to MLflow). Otherwise off, since there'd be no trace
   *   to attach feedback to.
   * - `true`: force on. Feedback controls show and writes are attempted
   *   regardless of env detection (use when the env is configured in a
   *   way the auto-probe doesn't recognize).
   * - `false`: force off. No trace-id header, no feedback route, no UI.
   *
   * Feedback attaches to a turn's MLflow trace via the OpenTelemetry
   * trace id the server stamps on each response; see `mlflow.ts`.
   */
  feedback?: boolean;
  /**
   * Expose the plugin's agents (and optionally tools) as a Mastra MCP
   * server so external MCP clients - Claude Desktop, Cursor, the Mastra
   * playground, or another agent - can call them over the standard MCP
   * transports. Enabled by default (agents only): wrapping the
   * already-registered agents costs nothing extra, so the endpoint is on
   * out of the box; only the ambient tools (which assume an in-process
   * chat turn) stay off unless explicitly opted in.
   *
   * - `undefined` (default) / `true`: expose every registered agent as
   *   an `ask_<agentId>` MCP tool under a server whose id is the plugin
   *   name.
   * - `false`: no MCP endpoints.
   * - {@link MastraMcpConfig}: fine-grained control over the server id,
   *   advertised metadata, and which agents / tools are exposed.
   *
   * When enabled, the stock Mastra MCP routes mount under the plugin's
   * base path (no bespoke route is added - the server is handed to the
   * `Mastra` instance via `mcpServers`, which `@mastra/express` serves):
   *
   * - Streamable HTTP: `POST /api/<plugin>/mcp/<serverId>/mcp`
   * - SSE (legacy):    `GET  /api/<plugin>/mcp/<serverId>/sse`
   *                    `POST /api/<plugin>/mcp/<serverId>/messages`
   *
   * Requests run under the same AppKit OBO scope as the chat routes, so
   * an agent invoked over MCP resolves its model and tools as the
   * calling user.
   */
  mcp?: boolean | MastraMcpConfig;
  /**
   * How much of the stock `@mastra/express` management API is reachable
   * through the plugin mount. `@mastra/express` registers its full route
   * table (agent inference plus admin / mutating routes: direct tool
   * execution, workflow control, raw memory read/write, telemetry, logs,
   * scores). AppKit already authenticates every request as the OBO user,
   * but nothing there restricts *which* of those operations the browser
   * client may invoke.
   *
   * - `"scoped"` (default): only the routes the chat client legitimately
   *   needs are dispatched to Mastra - agent inference
   *   (`stream` / `generate` / `network`), read-only agent metadata, this
   *   plugin's own OBO- and resource-scoped `/route/*` routes (history /
   *   threads), and, when {@link mcp} is enabled, the MCP transport.
   *   Everything else (tool execution, workflow control, raw memory,
   *   telemetry, logs, scores, and other mutations) is rejected with
   *   `403` before it reaches Mastra.
   * - `"full"`: dispatch the entire stock Mastra API. Use only for a
   *   trusted first-party console that genuinely needs the management
   *   surface.
   */
  apiAccess?: "scoped" | "full";
  /**
   * Which Databricks identity the agents' workspace calls run as: the
   * serving-endpoint catalogue behind the model picker, Genie suggestions,
   * `ask_genie`, and the Statement Execution fetch behind a `[data:<id>]`
   * embed. Falls back to `MASTRA_GENIE_IDENTITY`, then `"user"`.
   *
   * On-behalf-of (OBO) auth requires the caller to be a member of the
   * WORKSPACE, not just of the Databricks account. An app shared with an
   * account-level group can be opened by someone whose token is valid but whose
   * every workspace call fails with `Unauthorized access to Org: <id>` - and
   * granting workspace membership is not always possible, since a workspace
   * caps membership well below the size of a large account's user group. The
   * app's service principal already holds the grants the app was deployed with.
   *
   * - `"user"` (default): always OBO. Per-user attribution, and Genie / Unity
   *   Catalog row filters apply per user. Correct when every caller is a
   *   workspace member, and unchanged from before this option existed.
   * - `"service-principal"`: always the app service principal. Needs no OBO
   *   scopes and works for any caller who can open the app, at the cost of
   *   per-user attribution in Genie / Unity Catalog.
   *
   * `"service-principal"` changes only the Databricks CREDENTIAL. Memory
   * threads, the per-user cache namespace, and trace metadata still key off the
   * forwarded user, so callers sharing the service principal's data access keep
   * separate conversations and cannot read each other's threads or charts.
   *
   * @example An app any account user can open
   * ```ts
   * mastra({ genieIdentity: "service-principal", genieSpaces: { default: spaceId } });
   * ```
   */
  genieIdentity?: MastraIdentityMode;
  /**
   * Optional brand context applied to charts produced by the built-in
   * `render_data` / `prepare_chart` tools. When set, the chart planner's
   * Echarts output is themed with the brand's palette (series colors derived
   * from `colors.primary` / `colors.accent`) and sans font
   * (`typography.sans`) instead of Echarts' defaults. Omit for the default
   * Echarts look.
   *
   * Pass the portable {@link BrandContext} shared across the UI and
   * libraries (e.g. `brand.defaultBrandContext` from `@dbx-tools/shared-core`,
   * or a customer brand) - the same object the email add-on and the UI
   * `BrandProvider` consume, so a host themes charts, email, and UI from one
   * source.
   */
  brand?: BrandContext;
}

/**
 * JSON Schema published on the manifest's `config.schema`, mirroring the
 * documented defaults and environment fallbacks of {@link MastraPluginConfig}.
 *
 * Covers the JSON-expressible options only. `agents`, `tools`, and a
 * `defaultModel` passed as a Mastra `DynamicArgument` are code-defined
 * (functions / class instances), so they carry no schema entry; the
 * `defaultModel` property below describes its string form.
 */
export const MASTRA_CONFIG_SCHEMA: ConfigSchema = {
  type: "object",
  properties: {
    providerId: {
      type: "string",
      description: 'Mastra OpenAI-compatible provider id. Defaults to "databricks".',
    },
    storage: {
      type: ["boolean", "object"],
      description:
        "PostgresStore for Mastra threads / messages. `true` reuses the `lakebase` plugin's pool, an object opens a dedicated store. Auto-enabled when the `lakebase` plugin is registered.",
    },
    memory: {
      type: ["boolean", "object"],
      description:
        "PgVector store for Mastra semantic recall. `true` reuses the `lakebase` plugin's pool, an object opens a dedicated store. Auto-enabled when the `lakebase` plugin is registered.",
    },
    defaultAgent: {
      type: "string",
      description:
        "Agent id used when the client names none. Defaults to the first registered agent, else the built-in `default`.",
    },
    defaultModel: {
      type: "string",
      description:
        "Serving endpoint applied to every agent that omits its own model. Falls back to DATABRICKS_SERVING_ENDPOINT_NAME, then the auto-resolved catalogue.",
    },
    defaultModelFallbacks: {
      type: "array",
      items: { type: "string" },
      description:
        "Priority-ordered endpoint names tried before the score-classified catalogue when nothing else pins a model.",
    },
    modelFuzzyMatch: {
      type: "boolean",
      description:
        "Fuzzy-match loose model names against the workspace catalogue. Defaults to true.",
    },
    modelFuzzyThreshold: {
      type: "number",
      description:
        "Fuse.js score threshold for the fuzzy matcher, 0 (exact) to 1 (anything). Defaults to 0.4.",
    },
    modelCacheTtlMs: {
      type: "number",
      description:
        "TTL in ms for the serving-endpoints list cache, per workspace host. Defaults to 5 minutes.",
    },
    modelOverride: {
      type: "boolean",
      description:
        "Honor a per-request model override from the X-Mastra-Model header, ?model= query, or a `model` body field. Defaults to true.",
    },
    genieSpaces: {
      type: "object",
      additionalProperties: { type: ["string", "object"] },
      description:
        "Genie spaces the agents can delegate to, keyed by alias (the tool-name suffix). Each value is a space id or `{ spaceId, hint }`. Falls back to the `genie` plugin's own `spaces` config, then DATABRICKS_GENIE_SPACE_ID under the `default` alias.",
    },
    genieSpaceCacheTtlMs: {
      type: "number",
      description: "TTL in ms for the Genie space metadata cache. Defaults to 5 minutes.",
    },
    agentMaxSteps: {
      type: "number",
      description:
        "Maximum LLM steps each agent gets per turn (a tool call and the final reply each consume one). Defaults to 25.",
    },
    stripStaleCharts: {
      type: "boolean",
      description:
        "Strip chartIds from recalled assistant tool results so the model cannot reuse a turn-scoped chart marker. Defaults to true.",
    },
    styleInstructions: {
      type: ["string", "boolean"],
      description:
        "Style guardrails appended to every agent's instructions. A string replaces the built-in block, `false` disables it.",
    },
    observability: {
      type: "boolean",
      description:
        "Bridge Mastra spans into AppKit's OTel pipeline. Defaults to on only when OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set.",
    },
    feedback: {
      type: "boolean",
      description:
        "Log thumbs / comment assessments to MLflow and surface the feedback controls. Defaults to on only when an OTLP endpoint and MLFLOW_EXPERIMENT_ID or MLFLOW_EXPERIMENT_NAME are set.",
    },
    mcp: {
      type: ["boolean", "object"],
      description:
        "Expose the registered agents over MCP. Defaults to agents-only; an object tunes the server id, advertised metadata, and whether ambient tools are exposed.",
    },
    genieIdentity: {
      type: "string",
      enum: ["user", "service-principal"],
      description:
        'Which Databricks identity the agents\' workspace calls (serving catalogue, Genie, statement execution) run as. "user" (default) is always OBO, so callers must be workspace members; "service-principal" always uses the app service principal, so any caller who can open the app works, at the cost of per-user attribution. Falls back to MASTRA_GENIE_IDENTITY.',
    },
    apiAccess: {
      type: "string",
      enum: ["scoped", "full"],
      description:
        'How much of the stock @mastra/express API is reachable through the mount. "scoped" (default) allows agent inference, read-only agent metadata, this plugin\'s own routes, and MCP; "full" dispatches the entire management surface.',
    },
    brand: {
      type: "object",
      description:
        "Portable brand context applied to generated charts (series palette from colors.primary / colors.accent, base font from typography.sans).",
    },
  },
};
