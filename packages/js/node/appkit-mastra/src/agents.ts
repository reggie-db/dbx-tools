/**
 * Agent registration for the Mastra AppKit plugin.
 *
 * Mirrors the shape of the AppKit `agents` plugin (`config.agents` map
 * of {@link MastraAgentDefinition}, dual-form `tools` accepting a plain
 * record or a `(plugins) => tools` callback). Resolves each definition
 * into a Mastra `Agent` instance during plugin setup; user-supplied
 * tool callbacks are invoked exactly once with a typed
 * {@link MastraPlugins} map built from registered sibling plugins.
 *
 * When no agents are registered the plugin falls back to a single
 * built-in analyst so the bare `mastra()` call still mounts a working
 * streamable agent for demos.
 *
 * @module
 */

import { ConfigurationError } from "@databricks/appkit";
import type {
  AgentToolDefinition,
  PluginToolkitProvider,
  ToolkitEntry,
  ToolkitOptions as AppKitToolkitOptions,
  ToolProvider,
} from "@databricks/appkit/beta";
import { pluginRegistry, toolkitEntries } from "@dbx-tools/appkit";
import type { AgentToolExecutionContext } from "@dbx-tools/appkit/tool-provider";
import { errorUtils, log, object, stringUtils } from "@dbx-tools/shared-core";
import { TOOL_PROGRESS_PART_TYPE, ToolProgressEventSchema } from "@dbx-tools/shared-mastra/wire";
import type {
  AgentConfig,
  AgentExecutionOptions,
  AgentInstructions,
  ToolsInput,
} from "@mastra/core/agent";
import { Agent } from "@mastra/core/agent";
import { createEventedAgent } from "@mastra/core/agent/durable";
import { SkillSearchProcessor } from "@mastra/core/processors";
import type { OutputProcessor } from "@mastra/core/processors";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import type { RequestContext } from "@mastra/core/request-context";
import type { CodeModeTransport, Tool } from "@mastra/core/tools";
import { createCodeMode, createTool } from "@mastra/core/tools";
import type { Workspace } from "@mastra/core/workspace";
import { createWorkspaceTools } from "@mastra/core/workspace";
import type { PgVectorConfig, PostgresStoreConfig } from "@mastra/pg";
import { QuickJsCodeModeTransport } from "@mastra/quickjs";

import { buildRenderDataTool } from "./chart.ts";
import type { MastraPluginConfig } from "./config.ts";
import { buildGenieToolkitProvider, resolveGenieSpaces } from "./genie.ts";
import { withRequestMemoryScope, type MemoryBuilder } from "./memory.ts";
import { buildModel, RESPONSES_PROVIDER_OPTIONS } from "./model.ts";
import { stripStaleChartsProcessor } from "./processors.ts";
import { MASTRA_RESOLVED_MODEL_KEY } from "./serving.ts";
import { TYPOGRAPHY_RULE } from "./style.ts";
import { buildSummarizeTool } from "./summarize.ts";
import {
  bindDatabricksWorkspaceContext,
  databricksWorkspace,
  type DatabricksWorkspaceOptions,
} from "./workspaces.ts";

const codeModeLogger = log.logger("mastra/code-mode");
let resolvedCodeModeTransport: Promise<CodeModeTransport> | undefined;

/** Return whether this boot environment matches isolated-vm's supported app shape. */
function supportsIsolatedVmTransport(): boolean {
  if (process.versions.bun || process.release.name !== "node" || process.platform !== "linux") {
    return false;
  }
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 20 || nodeMajor >= 25) return false;
  const nodeOptions = process.env.NODE_OPTIONS?.split(/\s+/) ?? [];
  return [...process.execArgv, ...nodeOptions].includes("--no-node-snapshot");
}

/**
 * Tool record accepted by every Mastra `Agent.tools` field and by the
 * `tools(plugins)` callback on {@link MastraAgentDefinition}.
 *
 * Alias of Mastra's `ToolsInput`, so it already accepts:
 *
 * - Mastra tools built with {@link createTool} (or `new Tool(...)`)
 * - Mastra tools built with the AppKit-shaped {@link tool} wrapper
 *   below
 * - Vercel AI SDK tools (`tool({ ... })` from `ai`)
 * - Provider-defined tools (e.g. `openai.tools.webSearch(...)`)
 *
 * Existing tool libraries drop in as-is - nothing in this package
 * forces a rebuild.
 */
export type MastraTools = ToolsInput;

/** Re-export of Mastra's native `createTool` for full-feature access. */
export { createTool } from "@mastra/core/tools";

/**
 * AppKit-shaped tool factory. Lets users mix-and-match tools across
 * AppKit's `agents` plugin and `mastra` with a single import:
 *
 * ```ts
 * import { tool } from "@dbx-tools/appkit-mastra";
 * import { z } from "zod";
 *
 * get_weather: tool({
 *   description: "Weather",
 *   schema: z.object({ city: z.string() }),
 *   execute: async ({ city }) => `Sunny in ${city}`,
 * }),
 * ```
 *
 * Maps onto Mastra's `createTool`:
 *
 * - `description` -> `description` (required)
 * - `schema` -> `inputSchema` (optional)
 * - `execute(input)` -> `execute(input, ctx)` - Mastra already calls
 *   the first arg with the parsed inputs, so the body shape is
 *   identical. The Mastra `context` arg is forwarded as the second
 *   parameter when the caller declares it.
 * - `id`: optional. Defaults to a stable identifier derived from
 *   `description` (slugified, with a short hash suffix for
 *   uniqueness). Pass an explicit `id` when you need a stable string
 *   for tracing or MCP exposure.
 *
 * Reach for {@link createTool} when you need Mastra-only fields
 * (`outputSchema`, `suspendSchema`, `requireApproval`, `mcp`, etc.).
 */
export function tool(opts: AppKitToolOptions): Tool {
  const id = opts.id ?? deriveToolId(opts.description);
  return createTool({
    id,
    description: opts.description,
    ...(opts.schema ? { inputSchema: opts.schema as never } : {}),
    execute: opts.execute as never,
  });
}

/**
 * Input shape for the AppKit-style {@link tool} factory. A trimmed
 * subset of Mastra's `createTool` options that mirrors the
 * `@databricks/appkit/beta` `tool({ description, schema, execute })`
 * signature.
 *
 * Generics are intentionally absent - inference flows through the
 * caller's `schema` (typically a Zod object), and the `execute` body
 * destructures naturally from that. Reach for {@link createTool} when
 * you need the fully-typed input/output schemas wired explicitly.
 */
export interface AppKitToolOptions {
  /** Optional stable identifier; auto-derived from `description` when omitted. */
  id?: string;
  /** Human-readable description shown to the model. Required. */
  description: string;
  /**
   * Optional input schema (any Standard Schema instance, e.g. Zod).
   * Maps to Mastra's `inputSchema`; passed through to the model
   * verbatim.
   */
  schema?: unknown;
  /**
   * Execute body. First arg is the parsed input (typed off `schema`
   * when supplied), second arg is the full Mastra execution context
   * (request context, abort signal, mastra instance) if you need it.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any, context?: unknown) => unknown;
}

/**
 * Build a deterministic Mastra tool id from a description.
 * Delegates to {@link string.toUniqueSlug}: slug + always-on
 * 6-char FNV-1a base-32 suffix so two tools with the same leading
 * words don't collide in traces. Stable across runs.
 */
function deriveToolId(description: string): string {
  return stringUtils.toUniqueSlug(description, { fallbackPrefix: "tool" });
}

/**
 * Identity helper that brands a definition as a Mastra agent. Mirrors
 * AppKit's `createAgent(def)` so the registration shape matches:
 *
 * ```ts
 * const support = createAgent({
 *   instructions: "...",
 *   model: "databricks-claude-sonnet-4-6",
 *   tools(plugins) { return { ... }; },
 * });
 * ```
 *
 * Adds the package's default workspace when the definition omits one. That
 * workspace carries Databricks skill mounts while command execution stays
 * disabled until a sandbox is selected explicitly. An explicit workspace
 * remains the caller's complete override.
 */
export function createAgent<
  TRequestContext extends Record<string, unknown> | unknown = unknown,
  TDefinition extends MastraAgentDefinition<TRequestContext> =
    MastraAgentDefinition<TRequestContext>,
>(def: TDefinition): TDefinition {
  if (def.workspace) return { ...def };
  const workspace = databricksWorkspace();
  markDefaultWorkspace(workspace);
  return { ...def, workspace };
}

/**
 * Brand for a {@link Workspace} that `createAgent` built with no caller
 * options, so {@link buildAgents} may rebuild it with startup-provisioned
 * `extraSkillMounts` (a caller-supplied workspace is never touched).
 */
const defaultWorkspaces = new WeakSet<Workspace>();

/** Brand `workspace` as the auto-created default. */
function markDefaultWorkspace(workspace: Workspace): void {
  defaultWorkspaces.add(workspace);
}

/** Whether `workspace` was auto-created by {@link createAgent}. */
function isDefaultWorkspace(workspace: Workspace | undefined): boolean {
  return workspace !== undefined && defaultWorkspaces.has(workspace);
}

/**
 * Filter / rename options accepted by every plugin's `.toolkit()`
 * method, directly sourced from AppKit's public beta contract.
 */
export type ToolkitOptions = AppKitToolkitOptions;

/**
 * Toolkit provider shape every entry in the {@link MastraPlugins} map
 * exposes. Identical to AppKit's `PluginToolkitProvider` - any AppKit
 * plugin that implements the standard `ToolProvider` interface
 * (`getAgentTools` + `executeAgentTool` + `toolkit`) is reachable
 * through this surface automatically.
 */
export interface MastraPluginToolkitProvider {
  /**
   * Returns a Mastra-shaped tools record adapted from the plugin's
   * agent tools. Each tool dispatches back through the plugin's
   * `executeAgentTool` so OBO auth and telemetry spans stay intact.
   */
  toolkit(opts?: ToolkitOptions): MastraTools | Promise<MastraTools>;
}

/**
 * Plugin map handed to the function form of
 * {@link MastraAgentDefinition.tools}. Mirrors AppKit's `Plugins`
 * type exactly: a string-keyed record where every value exposes
 * `.toolkit(opts)`.
 *
 * Implemented as a runtime Proxy that auto-discovers any registered
 * AppKit plugin implementing the standard `ToolProvider` interface
 * (`analytics`, `files`, `lakebase`, `genie`, plus any third-party
 * plugin that does the same). Unknown names resolve to `undefined`
 * at runtime, so guard with `?.` and `?? {}` when spreading from a
 * plugin that may not be registered in every environment.
 *
 * @example
 * ```ts
 * createAgent({
 *   instructions: "...",
 *   async tools(plugins) {
 *     return {
 *       ...(await plugins.analytics.toolkit()),
 *       ...(await plugins.files.toolkit({ only: ["uploads.read"] })),
 *       get_weather: tool({
 *         description: "Weather",
 *         schema: z.object({ city: z.string() }),
 *         execute: async ({ city }) => `Sunny in ${city}`,
 *       }),
 *     };
 *   },
 * });
 * ```
 */
export type MastraPlugins = Record<string, MastraPluginToolkitProvider>;

/** Function form of {@link MastraAgentDefinition.tools}. */
export type MastraToolsFn = (plugins: MastraPlugins) => MastraTools | Promise<MastraTools>;

/** Function form of {@link MastraAgentDefinition.workspace}; `undefined` disables it for this agent. */
export type MastraAgentWorkspaceResolver = () => Workspace | undefined;

/**
 * A code-defined Mastra agent. Mirrors the shape AppKit's `agents`
 * plugin uses for `AgentDefinition`. The registry key under
 * `config.agents` is the `agentId` the client streams against; `name`
 * is purely informational (defaults to the key).
 */
export interface MastraAgentDefinition<
  TRequestContext extends Record<string, unknown> | unknown = unknown,
> {
  /** Display name used as `Agent.name`. Defaults to the registry key. */
  name?: string;
  /** Optional long-form description; surfaced as `Agent.description`. */
  description?: string;
  /** Static or request-context-aware system instructions. */
  instructions: AgentConfig<string, ToolsInput, undefined, TRequestContext>["instructions"];
  /** Native Mastra schema that validates and types application request context. */
  requestContextSchema?: AgentConfig<
    string,
    ToolsInput,
    undefined,
    TRequestContext
  >["requestContextSchema"];
  /**
   * Mastra-native per-call approval gate for this agent's tools. Supports an
   * async Classifier-backed function; tool-level approval remains authoritative.
   */
  requireToolApproval?: AgentExecutionOptions["requireToolApproval"];
  /**
   * Per-agent model override.
   *
   * - `undefined` (default): falls back to the workspace
   *   `/serving-endpoints` resolver that {@link buildModel} configures
   *   from the per-request `WorkspaceClient`.
   * - `string`: shorthand for "use the default resolver but swap the
   *   `modelId`" (e.g. `"databricks-meta-llama-3-3-70b-instruct"`).
   * - Any other Mastra `DynamicArgument<MastraModelConfig>`: passed
   *   straight through to `Agent.model`. Use this when you need full
   *   control over auth or providerId.
   */
  model?: AgentConfig<string, ToolsInput, undefined, TRequestContext>["model"] | string;
  /**
   * Per-agent tool record. Either a plain map or a callback that
   * receives the typed {@link MastraPlugins} sibling-plugin index and
   * returns a map. The callback runs exactly once at agent setup; the
   * result is cached for the agent's lifetime.
   */
  tools?: MastraTools | MastraToolsFn;
  /**
   * Per-agent semantic recall (PgVector) override. Cascades from
   * `config.memory`; the agent value wins when set.
   *
   * - `undefined` (default): inherit `config.memory`. When that's
   *   enabled, the agent **shares the plugin-level singleton `PgVector`
   *   instance** (cross-agent semantic recall across the same index).
   * - `false`: disable semantic recall for this agent only.
   * - `true`: enable using the shared singleton (same as default when
   *   plugin memory is enabled; useful to opt in when plugin disabled).
   * - {@link MastraMemoryConfig} object: dedicated `PgVector` for this
   *   agent (private recall index). Bypasses the shared singleton.
   */
  memory?: boolean | MastraMemoryConfigOverride;
  /**
   * Per-agent thread/message storage (`PostgresStore`) override.
   * Cascades from `config.storage`; the agent value wins when set.
   *
   * - `undefined` (default): inherit `config.storage`. When that's
   *   enabled, the agent gets its **own per-agent `PostgresStore`**
   *   keyed by {@link agentStorageSchemaName} so threads and
   *   messages stay isolated between agents in the same database.
   * - `false`: disable storage for this agent only (purely in-memory).
   * - `true`: enable with the per-agent default schema.
   * - {@link MastraStorageConfigOverride} object: dedicated
   *   `PostgresStore` config (custom schema, connection, etc.).
   */
  storage?: boolean | MastraStorageConfigOverride;
  /**
   * Mastra {@link Workspace} for this agent (filesystem, sandbox, or other
   * providers). Assistant skills from Databricks workspace paths are wired
   * via {@link databricksWorkspace}.
   */
  workspace?: Workspace | MastraAgentWorkspaceResolver;
}

/** Type-erased registry member; each definition retains typing at `createAgent`. */
export type AnyMastraAgentDefinition = MastraAgentDefinition<any>;

/**
 * Distributive `Omit` so unions in `PostgresStoreConfig` /
 * `PgVectorConfig` keep their discriminants after the override types
 * strip `id`. The built-in `Omit` collapses unions to one shape with
 * common fields only, which loses the connection-style discriminants.
 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/**
 * `PostgresStoreConfig` minus `id` - per-agent overrides accept any
 * Mastra-supported storage shape. `id` is filled in automatically
 * from the agent registry key so traces stay stable.
 */
export type MastraStorageConfigOverride = DistributiveOmit<PostgresStoreConfig, "id"> & {
  id?: string;
};

/**
 * `PgVectorConfig` minus `id` - per-agent overrides accept any
 * Mastra-supported vector shape. `id` is filled in automatically
 * from the agent registry key.
 */
export type MastraMemoryConfigOverride = DistributiveOmit<PgVectorConfig, "id"> & {
  id?: string;
};

/** How an agent's unpinned model is resolved. */
export type AgentDefaultModel =
  { kind: "auto" } | { kind: "configured"; model: string } | { kind: "dynamic" };

/** Output of {@link buildAgents}: resolved agents plus the default id. */
export interface BuiltAgents {
  agents: Record<string, Agent>;
  defaultAgentId: string;
  /**
   * Default model intent per agent id. An unconfigured agent is `"auto"` and
   * resolves the highest-ranked live endpoint; a string is `"configured"`; a
   * custom function is `"dynamic"`. Consumed by the plugin's
   * `GET /default-model` route.
   */
  defaultModels: Record<string, AgentDefaultModel>;
  /**
   * Ambient tools shared across every agent (the built-in system tools
   * spread with `config.tools`). Surfaced so the optional MCP server
   * can re-expose them when {@link MastraMcpConfig.tools} is enabled.
   */
  ambientTools: MastraTools;
}

/** Fallback agent id used when `config.agents` is omitted entirely. */
export const FALLBACK_AGENT_ID = "default";

/**
 * Default per-turn step ceiling applied to every registered agent
 * when {@link MastraPluginConfig.agentMaxSteps} is unset. Sized to
 * fit a decomposed Genie turn (grounding + several `ask_genie`
 * calls + `prepare_chart` per dataset + the final-text reply) with
 * headroom for the model to chain a couple of follow-ups before
 * answering - well above Mastra's own `agent.generate` default of
 * 5, which would cut multi-step orchestration off mid-loop.
 */
export const DEFAULT_AGENT_MAX_STEPS = 25;

const EVENTED_CONSTRUCTOR_MODEL = {
  specificationVersion: "v3",
  provider: "dbx-tools",
  modelId: "deferred",
  supportedUrls: {},
  async doGenerate() {
    throw new Error("Deferred evented constructor model must not execute");
  },
  async doStream() {
    throw new Error("Deferred evented constructor model must not execute");
  },
} as never;

/**
 * `EventedAgent` delegates model resolution to the wrapped agent at execution
 * time, but its constructor also probes an untyped `__model` slot and otherwise
 * calls `getModel()` with an empty request context. Temporarily filling that
 * probe avoids an eager service-principal lookup while preserving the wrapped
 * agent's request-scoped model resolver for real turns.
 */
function createBackgroundAgent(agent: Agent, maxSteps: number): Agent {
  const modelSlot = "__model";
  const descriptor = Object.getOwnPropertyDescriptor(agent, modelSlot);
  Object.defineProperty(agent, modelSlot, {
    configurable: true,
    value: EVENTED_CONSTRUCTOR_MODEL,
  });
  try {
    return createEventedAgent({ agent, maxSteps }) as unknown as Agent;
  } finally {
    if (descriptor) Object.defineProperty(agent, modelSlot, descriptor);
    else delete (agent as Agent & { __model?: unknown }).__model;
  }
}

const FALLBACK_AGENT_INSTRUCTIONS = `You are a data analyst. The user will ask questions about
business metrics and may share personal preferences you should remember across turns.

Rules:

1. Quote numbers exactly. Never invent data.
2. When the user states a preference or durable fact about themselves
   ("I'm in EU so use EUR", "always show me the SQL"), acknowledge that
   you will remember it.
3. If you don't have enough information to answer, ask a clarifying
   question instead of guessing.`;

/** Tool-call guidance appended to every registered agent. */
export const DEFAULT_TOOL_WORKFLOW_INSTRUCTIONS = [
  "Tool workflow:",
  "When the active model supports it, call multiple tools in the same turn when their inputs are independent, including multiple calls to the same tool.",
  "Keep calls sequential when a later input depends on an earlier result or when calls mutate the same resource.",
].join("\n");

/**
 * Style guardrails appended to every agent's `instructions` to curb
 * common LLM-isms (em dashes, emojis, sycophantic openers, excessive
 * hedging, throwaway closers). Appended rather than prepended so the
 * agent's role/context comes first; the model's recency bias then
 * helps the style rules dominate the response surface.
 *
 * Override globally via {@link MastraPluginConfig.styleInstructions}
 * (pass `false` to disable entirely, or a string to replace).
 */
export const DEFAULT_STYLE_INSTRUCTIONS = [
  "Output style:",
  "",
  "Use markdown formatting, including headings, lists, and code blocks.",
  "Avoid lists and headers for short replies.",
  "Plain prose.",
  TYPOGRAPHY_RULE,
  "Skip openers like 'Great question', 'Absolutely', and 'I'd be happy to help'.",
  "Skip closers like 'Let me know if you have any questions'.",
  "Skip self-disclaimers like 'I should mention' and 'It's important to note'.",
  "Answer directly.",
  "Do not include a preamble before the actual answer.",
  "Use lists and headers only when they clarify a multi-part answer.",
].join("\n");

/**
 * Resolve the style block to append to every agent's instructions.
 * Returns `null` when the caller opted out (`styleInstructions: false`).
 */
function resolveStyleInstructions(config: MastraPluginConfig): string | null {
  if (config.styleInstructions === false) return null;
  if (typeof config.styleInstructions === "string") {
    return config.styleInstructions;
  }

  return DEFAULT_STYLE_INSTRUCTIONS;
}

/** Append shared workflow and style blocks without narrowing Mastra's instruction shapes. */
function appendDefaultInstructions(
  instructions: AgentInstructions,
  style: string | null,
): AgentInstructions {
  const suffix = style
    ? `${DEFAULT_TOOL_WORKFLOW_INSTRUCTIONS}\n\n${style}`
    : DEFAULT_TOOL_WORKFLOW_INSTRUCTIONS;
  if (typeof instructions === "string") {
    return `${instructions.trimEnd()}\n\n${suffix}`;
  }
  if (Array.isArray(instructions)) {
    if (instructions.every((instruction) => typeof instruction === "string")) {
      return [...instructions, suffix] as AgentInstructions;
    }
    return [...instructions, { role: "system", content: suffix }] as AgentInstructions;
  }
  return [instructions, { role: "system", content: suffix }] as AgentInstructions;
}

/**
 * Compose static or request-context-aware instructions with shared workflow
 * and style guidance while preserving Mastra's native generic inference.
 */
function composeInstructions<TRequestContext extends Record<string, unknown> | unknown>(
  agentInstructions: AgentConfig<string, ToolsInput, undefined, TRequestContext>["instructions"],
  style: string | null,
  resolveCodeMode?: CodeModeResolver<TRequestContext>,
): AgentConfig<string, ToolsInput, undefined, TRequestContext>["instructions"] {
  const append = (instructions: AgentInstructions, codeModeInstructions?: string) => {
    const composed = appendDefaultInstructions(instructions, style);
    return codeModeInstructions ? appendInstructionBlock(composed, codeModeInstructions) : composed;
  };
  if (typeof agentInstructions !== "function" && !resolveCodeMode) {
    return append(agentInstructions) as AgentConfig<
      string,
      ToolsInput,
      undefined,
      TRequestContext
    >["instructions"];
  }
  return (async (args) => {
    const [instructions, codeMode] = await Promise.all([
      typeof agentInstructions === "function" ? agentInstructions(args) : agentInstructions,
      resolveCodeMode?.(args),
    ]);
    return append(instructions, codeMode?.instructions);
  }) as AgentConfig<string, ToolsInput, undefined, TRequestContext>["instructions"];
}

/** Append one system instruction block while preserving Mastra's accepted shapes. */
function appendInstructionBlock(instructions: AgentInstructions, block: string): AgentInstructions {
  if (typeof instructions === "string") return `${instructions.trimEnd()}\n\n${block}`;
  if (Array.isArray(instructions)) {
    if (instructions.every((instruction) => typeof instruction === "string")) {
      return [...instructions, block] as AgentInstructions;
    }
    return [...instructions, { role: "system", content: block }] as AgentInstructions;
  }
  return [instructions, { role: "system", content: block }] as AgentInstructions;
}

/** Resolve one native Code Mode transport during plugin startup. */
function codeModeTransport(): Promise<CodeModeTransport> {
  resolvedCodeModeTransport ??= (async () => {
    if (!supportsIsolatedVmTransport()) {
      codeModeLogger.info("transport selected", { provider: "quickjs" });
      return new QuickJsCodeModeTransport();
    }
    try {
      const { IsolatedVmCodeModeTransport } = await import("@mastra/isolated-vm");
      const transport = new IsolatedVmCodeModeTransport();
      codeModeLogger.info("transport selected", { provider: "isolated-vm" });
      return transport;
    } catch (caught) {
      codeModeLogger.warn("isolated-vm unavailable; using QuickJS", {
        error: errorUtils.errorMessage(caught),
      });
      return new QuickJsCodeModeTransport();
    }
  })();
  return resolvedCodeModeTransport;
}

type CodeModeResolver<TRequestContext extends Record<string, unknown> | unknown = unknown> = (
  args: Parameters<
    Exclude<
      AgentConfig<string, ToolsInput, undefined, TRequestContext>["instructions"],
      AgentInstructions
    >
  >[0],
) => Promise<ReturnType<typeof createCodeMode> | undefined>;

/** Build request-scoped native Code Mode over all executable context tools. */
async function buildCodeMode<TRequestContext extends Record<string, unknown> | unknown>(
  config: MastraPluginConfig,
  tools: MastraTools,
  workspace: Workspace | undefined,
  requestContext: RequestContext<TRequestContext>,
): Promise<ReturnType<typeof createCodeMode> | undefined> {
  if (config.codeMode === false) return undefined;
  const workspaceTools = workspace
    ? await createWorkspaceTools(workspace, { requestContext, workspace })
    : {};
  const contextTools = { ...tools, ...workspaceTools };
  const executableTools = Object.fromEntries(
    Object.entries(contextTools).filter(
      ([, tool]) =>
        typeof tool === "object" &&
        tool !== null &&
        "execute" in tool &&
        typeof tool.execute === "function",
    ),
  ) as ToolsInput;
  if (Object.keys(executableTools).length === 0) return undefined;
  const options = typeof config.codeMode === "object" ? config.codeMode : {};
  const codeMode = createCodeMode(
    { tools: executableTools, ...options },
    await codeModeTransport(),
  );
  if (!("mastra_workspace_read_file" in workspaceTools)) return codeMode;
  return {
    ...codeMode,
    instructions: `${codeMode.instructions}\n\nWorkspace file content note:\nText returned by external_mastra_workspace_read_file starts with one metadata line containing the path and size. Exclude that first line before calculating content character counts, hashes, or other content-only values.`,
  };
}

/** Resolve Code Mode lazily so workspace and dynamic tool policy follow each request. */
function codeModeResolver<TRequestContext extends Record<string, unknown> | unknown>(
  config: MastraPluginConfig,
  tools: MastraTools,
  workspace: Workspace | undefined,
): CodeModeResolver<TRequestContext> | undefined {
  if (config.codeMode === false) return undefined;
  return ({ requestContext }) => buildCodeMode(config, tools, workspace, requestContext);
}

/**
 * Generated description for an agent whose definition omits one. Kept
 * generic (the agent's own name is the only reliable signal at build
 * time) so it reads sensibly as the `ask_<id>` MCP tool's description
 * and in agent metadata.
 */
function defaultAgentDescription(name: string): string {
  return `Conversational AI agent "${name}".`;
}

/**
 * Resolve every entry in `config.agents` into a Mastra `Agent`
 * instance. When `config.agents` is omitted the plugin registers a
 * single built-in `default` analyst so the bare `mastra()` call still
 * yields a working agent.
 *
 * Per-agent tool callbacks are invoked once with a typed
 * {@link MastraPlugins} index built from registered sibling plugins
 * (currently `genie`; extend `MastraPlugins` to surface more).
 *
 * @throws when `config.defaultAgent` is set to an id that isn't in the
 *   resolved registry; this is a wiring bug, not a runtime condition.
 */
export async function buildAgents(opts: {
  config: MastraPluginConfig;
  context: pluginRegistry.PluginContextLike | undefined;
  memoryBuilder?: MemoryBuilder;
  log: log.Logger;
  /**
   * Local skill scan paths (remote skills provisioned to a temp dir at
   * startup) folded into every agent that uses the auto-created default
   * workspace.
   */
  extraSkillMounts?: DatabricksWorkspaceOptions["extraSkillMounts"];
}): Promise<BuiltAgents> {
  const { config, context, memoryBuilder, log, extraSkillMounts } = opts;
  const definitions = resolveDefinitions(config);
  const ids = Object.keys(definitions);
  const defaultAgentId = config.defaultAgent ?? ids[0] ?? FALLBACK_AGENT_ID;

  const plugins = buildPluginsMap(config, context);
  // System-default ambient tools every agent gets out of the box:
  // `render_data` for inline visualizations and `summarize` for
  // offloading text condensing to the fast / small chat tier. The
  // user can shadow either by including a same-named tool in their own
  // `config.tools` or per-agent `tools`. Merge order is
  // `system -> user-ambient -> per-agent`, last write wins.
  const systemTools: MastraTools = {
    render_data: buildRenderDataTool(config),
    summarize: buildSummarizeTool(config),
  };
  const ambientTools = {
    ...systemTools,
    ...(config.tools ?? {}),
  };
  const style = resolveStyleInstructions(config);
  // Default-on protection against the model copying turn-scoped
  // chartIds from prior assistant tool results into the new
  // turn's `[chart:<id>]` markers. Opt out per-plugin via
  // `config.stripStaleCharts: false`.
  const inputProcessors = [
    ...(config.stripStaleCharts === false ? [] : [stripStaleChartsProcessor]),
  ];
  const agents: Record<string, Agent> = {};
  const defaultModels: Record<string, AgentDefaultModel> = {};
  const approvalGatedByAgent: Array<{ agentId: string; toolIds: string[] }> = [];

  for (const [id, def] of Object.entries(definitions)) {
    const userTools = await resolveUserTools(def.tools, plugins);
    const tools = { ...ambientTools, ...userTools };
    let workspace = resolveAgentWorkspace(def.workspace);
    if (
      (def.workspace === undefined && !workspace) ||
      ((extraSkillMounts?.length ||
        config.sandbox !== undefined ||
        config.workspaceFallbackToTmp !== undefined ||
        config.workspaceTools !== undefined ||
        context !== undefined) &&
        isDefaultWorkspace(workspace))
    ) {
      workspace = databricksWorkspace({
        extraSkillMounts,
        fallbackToTmp: config.workspaceFallbackToTmp,
        ...(config.workspaceTools !== undefined ? { tools: config.workspaceTools } : {}),
        pluginContext: context,
        sandbox: config.sandbox === true ? "databricks" : config.sandbox,
      });
      markDefaultWorkspace(workspace);
    } else if (workspace) {
      workspace = bindDatabricksWorkspaceContext(workspace, context);
    }
    const gated = approvalGatedToolIds(tools);
    if (gated.length > 0) approvalGatedByAgent.push({ agentId: id, toolIds: gated });
    const memory = memoryBuilder?.forAgent(id, def);
    const resolveCodeMode = codeModeResolver(config, tools, workspace);
    const agent = new Agent({
      id,
      name: def.name ?? id,
      // Always carry a non-empty description: it's surfaced to MCP
      // clients (which reject a description-less agent) and in agent
      // metadata. Fall back to a generated one when the definition
      // omits it.
      description: def.description?.trim() || defaultAgentDescription(def.name ?? id),
      instructions: composeInstructions(def.instructions, style, resolveCodeMode),
      ...(def.requestContextSchema ? { requestContextSchema: def.requestContextSchema } : {}),
      model: resolveModel(config, def.model),
      defaultOptions: ({ requestContext }) =>
        withRequestMemoryScope(
          {
            maxSteps: config.agentMaxSteps ?? DEFAULT_AGENT_MAX_STEPS,
            providerOptions: RESPONSES_PROVIDER_OPTIONS,
            ...(def.requireToolApproval !== undefined
              ? { requireToolApproval: def.requireToolApproval }
              : {}),
          },
          memory ? requestContext : undefined,
        ),
      tools: resolveCodeMode
        ? async (args) => {
            const codeMode = await resolveCodeMode(args);
            return codeMode ? { ...tools, [codeMode.tool.id]: codeMode.tool } : tools;
          }
        : tools,
      ...(memory ? { memory } : {}),
      ...(workspace ? { workspace } : {}),
      inputProcessors: [...inputProcessors, ...workspaceSkillInputProcessors(workspace, config)],
      outputProcessors: [toolErrorLoggingProcessor(log)],
    });
    agents[id] =
      config.backgroundTurns === false
        ? agent
        : createBackgroundAgent(agent, config.agentMaxSteps ?? DEFAULT_AGENT_MAX_STEPS);
    // Surface the effective default model per agent so operators can
    // see at a glance which endpoint each agent points at without
    // having to fire a request and inspect a trace. The value is the
    // *static* default; per-request overrides (header / query /
    // body) and the workspace-catalogue fuzzy match still apply at
    // call time.
    const defaultModel = describeAgentDefaultModel(config, def);
    defaultModels[id] = defaultModel;
    log.info("agent registered", {
      id,
      name: def.name ?? id,
      defaultModel:
        defaultModel.kind === "configured" ? defaultModel.model : `<${defaultModel.kind}>`,
      tools: [...Object.keys(tools), ...(resolveCodeMode ? ["<dynamic-code-mode>"] : [])],
    });
  }

  if (!agents[defaultAgentId]) {
    throw ConfigurationError.resourceNotFound(
      `mastra defaultAgent "${defaultAgentId}"`,
      `Registered agents: ${ids.join(", ") || "none"}.`,
    );
  }

  assertApprovalGatedToolsHaveStorage(approvalGatedByAgent, memoryBuilder);

  log.info("agents ready", { ids, defaultAgentId });
  return { agents, defaultAgentId, defaultModels, ambientTools };
}

/** Log failed tool calls without changing the chunks returned to the client. */
function toolErrorLoggingProcessor(logger: log.Logger): OutputProcessor {
  return {
    id: "tool-error-logger",
    async processOutputStream({ part }) {
      if (part.type === "tool-error") {
        const error = errorUtils.toError(part.payload.error);
        logger.error("tool execution failed", {
          toolName: part.payload.toolName,
          toolCallId: part.payload.toolCallId,
          error: error.message,
          stack: error.stack,
        });
      }
      return part;
    },
  };
}

function workspaceSkillInputProcessors(
  workspace: Workspace | undefined,
  config: MastraPluginConfig,
): SkillSearchProcessor[] {
  if (!workspace || config.workspaceSkills === false) return [];
  const options = typeof config.workspaceSkills === "object" ? config.workspaceSkills : undefined;
  if (!workspace.skills) return [];
  return [
    new SkillSearchProcessor({
      workspace,
      search: {
        topK: options?.topK ?? 5,
        minScore: options?.minScore ?? 0.1,
      },
      ...(options?.ttlMs !== undefined ? { ttl: options.ttlMs } : {}),
      blockingRefresh: false,
    }),
  ];
}

/**
 * Tool ids on `tools` that are approval-gated (`requireApproval: true`).
 * Keys are used as a fallback when a tool omits an explicit `id`.
 */
export function approvalGatedToolIds(tools: MastraTools): string[] {
  if (!tools || typeof tools !== "object") return [];
  return [
    ...object
      .sequence(Object.entries(tools))
      .filter(([, tool]) => isApprovalGatedTool(tool))
      .map(([key, tool]) => resolveToolId(tool, key)),
  ];
}

/** True when a Mastra / AI SDK tool pauses for human approval before execute. */
function isApprovalGatedTool(tool: unknown): boolean {
  if (!tool || typeof tool !== "object") return false;
  return (tool as { requireApproval?: boolean }).requireApproval === true;
}

function resolveToolId(tool: unknown, fallbackKey: string): string {
  if (tool && typeof tool === "object" && typeof (tool as { id?: string }).id === "string") {
    return (tool as { id: string }).id;
  }
  return fallbackKey;
}

/**
 * Approval-gated tools suspend the agent loop until a human approves.
 * Mastra persists those suspended runs in Mastra-instance-level storage
 * (`memoryBuilder.instanceStorage()`), not per-agent memory - so boot
 * must fail fast when such a tool is registered without storage.
 */
function assertApprovalGatedToolsHaveStorage(
  gated: Array<{ agentId: string; toolIds: string[] }>,
  memoryBuilder: MemoryBuilder | undefined,
): void {
  if (gated.length === 0) return;
  if (memoryBuilder?.instanceStorage()) return;

  const detail = gated
    .map(({ agentId, toolIds }) => `${agentId}: ${toolIds.join(", ")}`)
    .join("; ");
  throw new ConfigurationError(
    "mastra: approval-gated tools require plugin storage (PostgresStore) to persist suspended runs. " +
      `Affected agents/tools: ${detail}. ` +
      "Register lakebase() before mastra() so storage auto-enables, or pass storage: true explicitly.",
  );
}

/**
 * Describe how an agent resolves its unpinned model:
 *
 *   1. Per-agent `def.model` (string sugar is configured; a function is
 *      dynamic).
 *   2. Plugin-level `config.defaultModel` (same rules).
 *   3. `DATABRICKS_SERVING_ENDPOINT_NAME` env var.
 *   4. Automatic live-catalogue ranking when none is set.
 *
 * Used for the startup `agent registered` log so operators can see
 * `defaultModelFallbacks` remains an operator-pinned candidate list inside the
 * automatic live lookup; it is not advertised as a model until availability is
 * checked.
 */
function describeAgentDefaultModel(
  config: MastraPluginConfig,
  def: AnyMastraAgentDefinition,
): AgentDefaultModel {
  const effective = def.model ?? config.defaultModel;
  if (typeof effective === "string") return { kind: "configured", model: effective };
  if (effective !== undefined) return { kind: "dynamic" };
  const environment = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
  return environment ? { kind: "configured", model: environment } : { kind: "auto" };
}

/**
 * Normalize `config.agents` into a `Record<id, definition>`. Accepts
 * any of the three shapes documented on
 * {@link MastraPluginConfig.agents}:
 *
 * - Record - returned as-is when non-empty.
 * - Single definition (detected via the required `instructions`
 *   field) - keyed by `slugify(def.name)` or `FALLBACK_AGENT_ID`.
 * - Array - keyed by `slugify(def.name)` or `agent_${i}`; duplicate
 *   slugs fail loudly so users know to set explicit names.
 *
 * Omitted or empty inputs fall back to a single built-in analyst so
 * the bare `mastra()` call still mounts a working chat route.
 */
function resolveDefinitions(config: MastraPluginConfig): Record<string, AnyMastraAgentDefinition> {
  const input = config.agents;
  if (!input) return fallbackDefinitions();

  if (Array.isArray(input)) {
    if (input.length === 0) return fallbackDefinitions();
    const out: Record<string, AnyMastraAgentDefinition> = {};
    input.forEach((def, i) => {
      const key = deriveAgentKey(def, i);
      if (out[key]) {
        throw new ConfigurationError(
          `mastra: duplicate agent id "${key}" derived from name "${def.name ?? ""}"; ` +
            `set unique \`name\`s on each definition`,
        );
      }
      out[key] = def;
    });
    return out;
  }

  // Single-definition shorthand: an agent owns the required `instructions`
  // field (static or dynamic); a record-of-agents never owns it directly.
  if ("instructions" in input) {
    const def = input as AnyMastraAgentDefinition;
    const key = deriveAgentKey(def);
    return { [key]: def };
  }

  const record = input as Record<string, AnyMastraAgentDefinition>;
  if (Object.keys(record).length === 0) return fallbackDefinitions();
  return record;
}

/** Derive a registry id from a definition's `name`, with a fallback. */
function deriveAgentKey(def: AnyMastraAgentDefinition, index?: number): string {
  if (def.name) {
    const slug = stringUtils.toIdentifier(def.name);
    if (slug) return slug;
  }
  return index === undefined ? FALLBACK_AGENT_ID : `agent_${index}`;
}

/** Built-in fallback registry used when `agents` is omitted / empty. */
function fallbackDefinitions(): Record<string, AnyMastraAgentDefinition> {
  return {
    [FALLBACK_AGENT_ID]: {
      name: "Default Agent",
      instructions: FALLBACK_AGENT_INSTRUCTIONS,
    },
  };
}

/**
 * Pick the effective model spec for an agent. Fallback ladder, in
 * order:
 *
 *   1. Per-agent `def.model` (string sugar or `DynamicArgument`).
 *   2. Plugin-level `config.defaultModel` (string sugar or
 *      `DynamicArgument`) - mirrors AppKit's `agents({ defaultModel })`.
 *   3. The auto-resolver that mints user-scoped tokens against
 *      `/serving-endpoints` via {@link buildModel}.
 *
 * String values are treated as `modelId` sugar and threaded through
 * `buildModel`'s override hook so the runtime fuzzy matcher and the
 * per-request `X-Mastra-Model` override layer on top of the static
 * choice. Non-string `DynamicArgument`s are passed through verbatim;
 * callers that need full control over `providerId` / `headers` /
 * `modelId` bypass the resolver pipeline entirely.
 */
function resolveModel(
  config: MastraPluginConfig,
  override: AnyMastraAgentDefinition["model"],
): AgentConfig["model"] {
  const effective = override ?? config.defaultModel;
  if (effective === undefined) {
    return ({ requestContext }) => buildModel(config, requestContext);
  }
  if (typeof effective === "string") {
    const modelId = effective;
    return ({ requestContext }) => buildModel(config, requestContext, { modelId });
  }
  return effective;
}

/**
 * Resolve only the tools explicitly supplied by one agent definition.
 * Callback errors propagate verbatim so the original stack survives - the
 * caller already knows which agent was registering.
 */
async function resolveUserTools(
  defTools: AnyMastraAgentDefinition["tools"],
  plugins: MastraPlugins,
): Promise<MastraTools> {
  if (!defTools) return {};
  return typeof defTools === "function" ? defTools(plugins) : defTools;
}

function resolveAgentWorkspace(
  workspace: AnyMastraAgentDefinition["workspace"],
): Workspace | undefined {
  if (!workspace) return undefined;
  return typeof workspace === "function" ? workspace() : workspace;
}

/**
 * Build the {@link MastraPlugins} runtime proxy handed to
 * `tools(plugins)` callbacks.
 *
 * Implemented as a `Proxy` over the AppKit plugin context so
 * `plugins.<name>` resolves at first access. Any sibling plugin that
 * implements AppKit's standard `ToolProvider` interface
 * (`toolkit(opts?)` + `executeAgentTool(name, args, signal?, context?)`) is
 * auto-adapted into Mastra tools. Unknown names return `undefined`,
 * matching AppKit's `Plugins` semantics so `plugins.foo?.toolkit()`
 * remains safe in environments where `foo` isn't registered.
 *
 * `genie` is special-cased to swap the generic AppKit toolkit (which
 * runs `executeAgentTool` and only emits a single final `tool-result`
 * chunk per call) for the streaming-aware tools built by
 * {@link buildGenieToolkitProvider}. The streaming variant forwards each
 * Genie wire event (status, SQL, row counts, errors) out through the
 * Mastra `ctx.writer`, so the UI gets `tool-output` chunks in real
 * time instead of staring at a spinner for the full Genie round-trip.
 */
function buildPluginsMap(
  config: MastraPluginConfig,
  context: pluginRegistry.PluginContextLike | undefined,
): MastraPlugins {
  const cache = new Map<string, MastraPluginToolkitProvider | null>();
  return new Proxy({} as MastraPlugins, {
    get(_target, propName) {
      if (typeof propName !== "string") return undefined;
      if (cache.has(propName)) return cache.get(propName) ?? undefined;
      const provider = resolveProvider(config, context, propName);
      cache.set(propName, provider);
      return provider ?? undefined;
    },
  });
}

/**
 * Pick the right {@link MastraPluginToolkitProvider} for a sibling
 * plugin lookup. Returns the Genie agent-backed adapter when
 * the caller asks for `genie` AND at least one space is reachable
 * via {@link resolveGenieSpaces} (the explicit
 * `config.genieSpaces`, the registered AppKit `genie()` plugin's
 * `spaces` config, or the `DATABRICKS_GENIE_SPACE_ID` env var).
 * Falls back to the generic AppKit `ToolProvider` adapter for
 * every other plugin name. `config` is threaded through so the
 * Genie agent inherits the same model resolver / fallback
 * ladder the calling agents use.
 *
 * The Genie tools talk to Genie directly through `@dbx-tools/genie`
 * (`genieEventChat`) and the workspace `statementExecution.getStatement`
 * API; AppKit's stock `genie` plugin contributes only its resource
 * manifest and `spaces` config, so an `app.yaml` resource binding and a
 * `genie({ spaces })` record have the same meaning here as they do there.
 */
function resolveProvider(
  config: MastraPluginConfig,
  context: pluginRegistry.PluginContextLike | undefined,
  propName: string,
): MastraPluginToolkitProvider | null {
  if (propName === "genie") {
    const spaces = resolveGenieSpaces(config, context);
    if (Object.keys(spaces).length === 0) return null;
    return buildGenieToolkitProvider({
      spaces,
      config,
    }) as MastraPluginToolkitProvider;
  }
  const plugin = context?.getPlugins().get(propName);
  return adaptPluginToolkit(plugin, propName);
}

type ContextualToolProvider = Partial<Pick<ToolProvider, "getAgentTools">> & {
  toolkit?: (
    opts?: ToolkitOptions,
  ) =>
    | ReturnType<PluginToolkitProvider["toolkit"]>
    | Promise<ReturnType<PluginToolkitProvider["toolkit"]>>;
  executeAgentTool?: (
    name: string,
    args: unknown,
    signal?: AbortSignal,
    context?: AgentToolExecutionContext,
  ) => Promise<unknown>;
};

/**
 * Adapt an AppKit `ToolProvider` plugin instance into a
 * {@link MastraPluginToolkitProvider}. Returns `null` for any plugin
 * that doesn't implement `executeAgentTool` plus either AppKit's native
 * `toolkit` or `getAgentTools` surface.
 */
function adaptPluginToolkit(
  plugin: unknown,
  pluginName: string,
): MastraPluginToolkitProvider | null {
  if (!plugin || typeof plugin !== "object") return null;
  const p = plugin as ContextualToolProvider;
  if (
    typeof p.executeAgentTool !== "function" ||
    (typeof p.toolkit !== "function" && typeof p.getAgentTools !== "function")
  ) {
    return null;
  }
  return {
    toolkit(opts?: ToolkitOptions): MastraTools | Promise<MastraTools> {
      const entries =
        typeof p.toolkit === "function"
          ? p.toolkit(opts)
          : toolkitEntriesFromDefinitions(pluginName, p.getAgentTools!(), opts);
      if (isPromiseLike(entries)) {
        return entries.then((resolved) => toolkitEntriesToMastraTools(resolved, p));
      }
      return toolkitEntriesToMastraTools(entries, p);
    },
  };
}

function toolkitEntriesFromDefinitions(
  pluginName: string,
  definitions: AgentToolDefinition[],
  options: ToolkitOptions = {},
): Record<string, ToolkitEntry> {
  return toolkitEntries.entries(pluginName, definitions, options);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown })?.then === "function";
}

function toolkitEntriesToMastraTools(
  entries: Record<string, ToolkitEntry>,
  plugin: ContextualToolProvider,
): MastraTools {
  const tools: MastraTools = {};
  for (const [key, entry] of Object.entries(entries)) {
    tools[key] = toolkitEntryToMastraTool(entry, plugin);
  }
  return tools;
}

/**
 * Wrap a single {@link AppKitToolkitEntry} as a Mastra tool whose
 * `execute` dispatches back through `plugin.executeAgentTool(...)` so
 * AppKit's OBO auth (`asUser`), telemetry spans, and the Mastra memory resource
 * id stay intact. JSON Schema parameters pass through unchanged - Mastra's
 * `PublicSchema` accepts `JSONSchema7` directly via `@mastra/schema-compat`.
 */
function toolkitEntryToMastraTool(entry: ToolkitEntry, plugin: ContextualToolProvider): Tool {
  const annotations = entry.annotations ?? entry.def.annotations;
  const effect = annotations?.effect;
  const requiresApproval = effect === "destructive" || annotations?.destructive === true;
  return createTool({
    id: `${entry.pluginName}__${entry.localName}`,
    description: entry.def.description,
    ...(entry.def.parameters ? { inputSchema: entry.def.parameters as never } : {}),
    ...(requiresApproval ? { requireApproval: true } : {}),
    ...(annotations
      ? {
          mcp: {
            annotations: {
              readOnlyHint: effect === "read" || annotations.readOnly === true,
              destructiveHint: effect === "destructive" || annotations.destructive === true,
              idempotentHint: annotations.idempotent,
            },
          },
        }
      : {}),
    execute: async (input: unknown, context: unknown) => {
      const execution = context as
        | {
            agent?: { toolCallId?: string };
            abortSignal?: AbortSignal;
            requestContext?: { get(key: string): unknown };
            writer?: {
              custom(part: { type: string; data: unknown }): Promise<void>;
            };
          }
        | undefined;
      const resourceId = execution?.requestContext?.get(MASTRA_RESOURCE_ID_KEY);
      const model = execution?.requestContext?.get(MASTRA_RESOLVED_MODEL_KEY);
      const toolCallId = execution?.agent?.toolCallId;
      const writer = execution?.writer;
      return plugin.executeAgentTool!(entry.localName, input, execution?.abortSignal, {
        ...(typeof resourceId === "string" ? { resourceId } : {}),
        ...(typeof model === "string" ? { model } : {}),
        ...(writer && toolCallId
          ? {
              writeProgress: async (event: unknown) => {
                const parsed = ToolProgressEventSchema.parse(event);
                await writer
                  .custom({
                    type: TOOL_PROGRESS_PART_TYPE,
                    data: { toolCallId, event: parsed },
                  })
                  .catch(() => undefined);
              },
            }
          : {}),
      });
    },
  });
}
