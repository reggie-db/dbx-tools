/**
 * AppKit plugin that supervises Graphiti and publishes direct user-scoped tools.
 *
 * @module
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { ConfigurationError, Plugin, toPlugin, type PluginManifest } from "@databricks/appkit";
import type {
  AgentToolDefinition,
  ToolkitEntry,
  ToolkitOptions,
  ToolAnnotations,
  ToolProvider,
} from "@databricks/appkit/beta";
import { appkit as dbxAppkit, toolkitEntries } from "@dbx-tools/appkit";
import type { AppKitChildProcess } from "@dbx-tools/appkit/child-process";
import { openApiTools, type OpenApiTool } from "@dbx-tools/appkit-mastra/openapi-tool";
import { configUtils } from "@dbx-tools/core";
import { errorUtils, log, object } from "@dbx-tools/shared-core";

import {
  GRAPHITI_CONFIG_SCHEMA,
  resolveGraphitiConfig,
  type GraphitiPluginConfig,
  type ResolvedGraphitiPluginConfig,
} from "./config.ts";
import { graphitiOptionOverrides, resolveGraphitiOptions } from "./options.ts";
import {
  createGraphitiChildProcess,
  graphitiHttpUrl,
  graphitiRequestHeaders,
  remainingTimeoutMs,
  waitForGraphitiHealth,
} from "./runtime.ts";

const SCOPED_TOOL_FIELDS = {
  add_memory: "group_id",
  add_memory_sync: "group_id",
  add_triplet: "group_id",
  build_communities: "group_ids",
  get_episodes: "group_ids",
  get_queue_status: "group_id",
  get_status: undefined,
  search_memory_facts: "group_ids",
  search_nodes: "group_ids",
  summarize_saga: "group_id",
  wait_for_memory_queue: "group_id",
} as const;
const TOOL_NAMES = Object.keys(SCOPED_TOOL_FIELDS);
const AGENT_TOOLS = [
  {
    name: "add_memory",
    operation: "add_memory_sync",
    description:
      "Persist durable knowledge from text, JSON, or message content. Use this when the user " +
      "asks to remember or save information. The call waits for extraction and the durable storage " +
      "commit before returning; omit uuid when creating a new episode.",
  },
  {
    name: "add_triplet",
    operation: "add_triplet",
    description:
      "Persist one explicit source-relationship-target fact. Use only when the entity names and " +
      "relationship are already clear; prefer add_memory for unstructured content.",
  },
  {
    name: "search_memory_facts",
    operation: "search_memory_facts",
    description:
      "Search durable relationship facts extracted from memory. Use this for questions about what " +
      "entities did, know, prefer, own, or are related to.",
  },
  {
    name: "search_nodes",
    operation: "search_nodes",
    description:
      "Search durable entities and their summaries. Use this to find people, organizations, " +
      "products, places, or concepts rather than relationship facts.",
  },
  {
    name: "get_episodes",
    operation: "get_episodes",
    description:
      "List recently ingested source episodes. Use this to inspect original memory inputs or their " +
      "episode identifiers, not for semantic fact retrieval.",
  },
  {
    name: "summarize_saga",
    operation: "summarize_saga",
    description:
      "Generate or refresh the summary of a named saga previously assigned through add_memory.",
  },
  {
    name: "build_communities",
    operation: "build_communities",
    description:
      "Run expensive graph-wide community detection and summaries. Use only when the user " +
      "explicitly requests community analysis or maintenance.",
  },
  {
    name: "get_status",
    operation: "get_status",
    description:
      "Check Graphiti and storage connectivity. Use only for memory-service diagnostics.",
  },
] as const;
const WRITE_TOOLS = new Set([
  "add_memory",
  "add_memory_sync",
  "add_triplet",
  "build_communities",
  "summarize_saga",
]);
const UNSCOPED_ARGUMENTS = [
  "center_node_uuid",
  "previous_episode_uuids",
  "saga_previous_episode_uuid",
  "source_node_uuid",
  "target_node_uuid",
  "uuid",
] as const;
const HIDDEN_TOOL_ARGUMENTS = new Set(["group_id", "group_ids", ...UNSCOPED_ARGUMENTS]);

/** AppKit plugin that runs Graphiti and publishes user-scoped memory tools. */
export class GraphitiPlugin extends Plugin<GraphitiPluginConfig> implements ToolProvider {
  static manifest: PluginManifest<"graphiti"> = {
    name: "graphiti",
    displayName: "Graphiti",
    description:
      "Runs the dbx-tools Graphiti sidecar with PostgreSQL graph storage and publishes " +
      "direct user-scoped memory tools.",
    stability: "beta",
    resources: { required: [], optional: [] },
    config: { schema: GRAPHITI_CONFIG_SCHEMA },
  };

  private readonly logger = log.logger(this);
  private resolved?: ResolvedGraphitiPluginConfig;
  private sidecar?: AppKitChildProcess;
  private ready?: Promise<void>;
  private readyWatch?: AbortController;
  private toolSchemas: OpenApiTool[] = [];

  override async setup(): Promise<void> {
    await this.startSidecar();
  }

  private async startSidecar(): Promise<void> {
    const configured = resolveGraphitiConfig(this.config);
    if (configured.listen.scheme !== "tcp") {
      throw new Error("AppKit Graphiti requires a TCP listener");
    }
    const [graphitiPort] = await distinctPorts(
      configUtils.port(undefined, "DATABRICKS_APP_PORT", 8000, configUtils.ENV_ONLY),
      configured.listen.port,
    );
    const resolved = resolveGraphitiOptions({
      ...graphitiOptionOverrides(configured),
      bearer: randomBytes(32).toString("base64url"),
      listen: { ...configured.listen, port: graphitiPort },
    });
    this.resolved = resolved;
    const startedAt = Date.now();
    const openApiUrl = graphitiHttpUrl(resolved, "/openapi.json");
    let toolSchemas: OpenApiTool[] | undefined;
    const sidecar = await createGraphitiChildProcess({
      ...resolved,
      healthCheck: async ({ signal }) => {
        try {
          const schemas = await openApiTools(openApiUrl, {
            signal,
            headers: graphitiRequestHeaders(resolved),
          });
          if (schemas.length === 0) return false;
          toolSchemas = schemas;
          return true;
        } catch (error) {
          if (signal.aborted) throw error;
          return false;
        }
      },
    });
    this.sidecar = sidecar;
    try {
      await sidecar.start();
      const child = sidecar.process;
      if (!child) throw new Error("Graphiti sidecar exited after becoming ready");
      if (!toolSchemas) {
        throw new Error("Graphiti OpenAPI tools were not captured during readiness");
      }
      this.toolSchemas = selectToolSchemas(toolSchemas);
      this.watchSidecarHealth(remainingTimeoutMs(startedAt, resolved.startupTimeoutMs));
      this.logger.info("sidecar listening", { graphitiPort: resolved.listen.port });
    } catch (error) {
      await sidecar.shutdown();
      if (this.sidecar === sidecar) this.sidecar = undefined;
      throw error;
    }
  }

  /**
   * Poll `/healthcheck` with whatever startup budget remains after OpenAPI
   * becomes available. Tool calls await the same promise. A timeout or probe
   * error tears down this plugin and asks AppKit to exit via SIGTERM.
   */
  private watchSidecarHealth(timeoutMs: number): void {
    const resolved = this.resolved;
    if (!resolved) return;
    this.readyWatch?.abort();
    const controller = new AbortController();
    this.readyWatch = controller;
    const ready = waitForGraphitiHealth(resolved, timeoutMs, controller.signal).then(
      () => {
        if (this.readyWatch === controller) {
          this.logger.info("sidecar ready", { graphitiPort: resolved.listen.port });
        }
      },
      async (error) => {
        if (controller.signal.aborted) throw error;
        this.logger.error("sidecar healthcheck failed", {
          error: errorUtils.errorMessage(error),
        });
        await this.failAppkit();
        throw error;
      },
    );
    this.ready = ready;
    // Tool callers still receive the rejection from `this.ready`; this observer
    // prevents an expected shutdown abort from becoming an unhandled rejection.
    void ready.catch(() => undefined);
  }

  /** Stop the sidecar, then signal AppKit's process-level graceful shutdown. */
  private async failAppkit(): Promise<void> {
    await this.shutdown();
    process.kill(process.pid, "SIGTERM");
  }

  async shutdown(): Promise<void> {
    this.readyWatch?.abort();
    this.readyWatch = undefined;
    this.ready = undefined;
    const sidecar = this.sidecar;
    this.sidecar = undefined;
    await sidecar?.shutdown();
  }

  async toolkit(options?: ToolkitOptions): Promise<Record<string, ToolkitEntry>> {
    return toolkitEntries.entries("graphiti", this.getAgentTools(), options);
  }

  getAgentTools(): AgentToolDefinition[] {
    return AGENT_TOOLS.map(({ name, operation, description }) => {
      const schema = this.toolSchemas.find(({ id }) => id === operation);
      if (!schema) throw new Error(`Graphiti OpenAPI is missing agent operation: ${operation}`);
      return {
        name,
        description,
        parameters: hideArguments(schema.inputSchema, HIDDEN_TOOL_ARGUMENTS),
        annotations: toolAnnotations(operation),
      };
    });
  }

  async executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    context?: { resourceId?: string },
  ): Promise<unknown> {
    const operation = agentOperation(name);
    const toolSchema = this.toolSchemas.find(({ id }) => id === operation);
    if (!toolSchema) throw new Error(`Unknown Graphiti tool: ${name}`);
    if (!this.resolved || !this.sidecar?.running) {
      throw new Error("Graphiti sidecar is not running");
    }
    if (!this.resolved.bearer) throw new Error("Graphiti sidecar bearer is not configured");
    await this.ready;
    const userId = context?.resourceId ?? executionContextUserId();
    const response = await fetch(toolSchema.url, {
      method: toolSchema.method,
      headers: {
        ...graphitiRequestHeaders(this.resolved),
        "content-type": "application/json",
      },
      body: JSON.stringify(scopedArguments(operation, args, userScope(userId))),
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Graphiti tool ${name} failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return response.json();
  }
}

/** AppKit registration factory for {@link GraphitiPlugin}. */
export const graphiti = toPlugin(GraphitiPlugin);

function executionContextUserId(): string {
  const context = dbxAppkit.tryGetExecutionContext();
  if (!context) throw new Error("Graphiti memory requires an AppKit execution context");
  return "userId" in context ? context.userId : context.serviceUserId;
}

function userScope(userId: string): string {
  return `user_${createHash("sha256").update(userId).digest("base64url")}`;
}

function scopedArguments(name: string, args: unknown, scope: string): Record<string, unknown> {
  if (!(name in SCOPED_TOOL_FIELDS)) throw new Error(`Graphiti tool is not user-scoped: ${name}`);
  const scoped = object.isRecord(args) ? { ...args } : {};
  for (const argument of UNSCOPED_ARGUMENTS) delete scoped[argument];
  const field = SCOPED_TOOL_FIELDS[name as keyof typeof SCOPED_TOOL_FIELDS];
  if (field === "group_id") scoped.group_id = scope;
  if (field === "group_ids") scoped.group_ids = [scope];
  return scoped;
}

function toolAnnotations(name: string): ToolAnnotations {
  return {
    effect: WRITE_TOOLS.has(name) ? "write" : "read",
    requiresUserContext: true,
  };
}

function agentOperation(name: string): string {
  return AGENT_TOOLS.find((tool) => tool.name === name)?.operation ?? name;
}

function selectToolSchemas(schemas: readonly OpenApiTool[]): OpenApiTool[] {
  return TOOL_NAMES.map((name) => {
    const schema = schemas.find(({ id }) => id === name);
    if (!schema) throw new Error(`Graphiti OpenAPI is missing tool operation: ${name}`);
    return schema;
  });
}

function hideArguments(
  schema: OpenApiTool["inputSchema"],
  hiddenArguments: ReadonlySet<string>,
): OpenApiTool["inputSchema"] {
  const { properties: sourceProperties, required: sourceRequired, ...rest } = schema;
  const properties = object.isRecord(sourceProperties) ? { ...sourceProperties } : undefined;
  if (properties) {
    for (const name of hiddenArguments) delete properties[name];
  }
  const required = sourceRequired?.filter((name) => !hiddenArguments.has(name));
  return {
    ...rest,
    ...(properties ? { properties } : {}),
    ...(required?.length ? { required } : {}),
  };
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a Graphiti loopback port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function distinctPorts(appPort: number, graphitiPort: number): Promise<[number]> {
  const ports = [appPort];
  for (const configuredPort of [graphitiPort]) {
    if (configuredPort && ports.includes(configuredPort)) {
      throw new ConfigurationError("Graphiti sidecar ports must differ from DATABRICKS_APP_PORT");
    }
    let port = configuredPort || (await availablePort());
    while (ports.includes(port)) port = await availablePort();
    ports.push(port);
  }
  return ports.slice(1) as [number];
}
