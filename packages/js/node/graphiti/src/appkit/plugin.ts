/**
 * AppKit plugin that supervises Graphiti and publishes direct user-scoped tools.
 *
 * @module
 */
import { createHash } from "node:crypto";
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
import { configUtils } from "@dbx-tools/core";
import { asyncUtils, log, object } from "@dbx-tools/shared-core";

import { graphitiOptionOverrides, resolveGraphitiOptions } from "../options.ts";
import { graphitiOpenApi, startGraphitiRuntime, type GraphitiRuntime } from "../runtime.ts";
import { graphitiToolContracts, type GraphitiToolContract } from "./_openapi.ts";
import {
  GRAPHITI_CONFIG_SCHEMA,
  resolveGraphitiConfig,
  type GraphitiPluginConfig,
  type ResolvedGraphitiPluginConfig,
} from "./config.ts";

const STARTUP_RETRY_MS = 250;
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
  private runtime?: GraphitiRuntime;
  private setupComplete = false;
  private startup?: Promise<void>;
  private stopping = false;
  private toolContracts: Record<string, GraphitiToolContract> = {};

  override async setup(): Promise<void> {
    await this.loadToolContracts();
    this.startup = this.startSidecar();
    void this.startup.catch((error: unknown) => {
      if (this.stopping) return;
      this.logger.error("background startup failed", { error });
      process.kill(process.pid, "SIGTERM");
    });
    void this.startup;
    this.logger.info("background startup scheduled");
  }

  private async loadToolContracts(): Promise<void> {
    this.toolContracts = graphitiToolContracts(
      await graphitiOpenApi(),
      TOOL_NAMES,
      HIDDEN_TOOL_ARGUMENTS,
    );
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
      listen: { ...configured.listen, port: graphitiPort },
    });
    this.resolved = resolved;
    this.runtime = await startGraphitiRuntime(resolved);
    this.setupComplete = true;
    void this.runtime.result.then(
      () => this.onSupervisorExit(),
      (error) => this.onSupervisorExit(error),
    );
    await this.waitUntilReady();
    this.logger.info("sidecar ready", { graphitiPort: resolved.listen.port });
  }

  async shutdown(): Promise<void> {
    await this.stopSidecar();
  }

  async toolkit(options?: ToolkitOptions): Promise<Record<string, ToolkitEntry>> {
    return toolkitEntries.entries("graphiti", this.getAgentTools(), options);
  }

  getAgentTools(): AgentToolDefinition[] {
    const names = new Set(Object.keys(this.toolContracts));
    return Object.entries(this.toolContracts)
      .filter(([name]) => !hasUnsuffixedTool(name, names))
      .map(([, { definition }]) => ({
        ...definition,
        annotations: toolAnnotations(definition.name),
      }));
  }

  async executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    context?: { resourceId?: string },
  ): Promise<unknown> {
    const contract = this.toolContracts[name];
    if (!contract) throw new Error(`Unknown Graphiti tool: ${name}`);
    if (!this.startup) throw new Error("Graphiti sidecar startup has not been scheduled");
    await abortable(this.startup, signal);
    if (!this.resolved) throw new Error("Graphiti sidecar did not launch");
    const userId = context?.resourceId ?? executionContextUserId();
    const response = await fetch(`http://127.0.0.1:${this.resolved.listen.port}${contract.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scopedArguments(name, args, userScope(userId))),
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Graphiti tool ${name} failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return response.json();
  }

  private async waitUntilReady(): Promise<void> {
    if (!this.resolved) throw new Error("Graphiti sidecar did not launch");
    const url = `http://127.0.0.1:${this.resolved.listen.port}/healthcheck`;
    const deadline = Date.now() + this.resolved.startupTimeoutMs;
    let lastError: unknown;
    while (!this.stopping && Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) return;
        lastError = new Error(`Graphiti healthcheck returned HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await asyncUtils.sleep(STARTUP_RETRY_MS);
    }
    if (this.stopping) throw new Error("Graphiti stopped before becoming ready");
    throw new Error("Graphiti sidecar readiness timed out", { cause: lastError });
  }

  private onSupervisorExit(error?: unknown): void {
    if (this.stopping || !this.setupComplete) return;
    this.logger.error("sidecar supervisor exited", { error });
    process.kill(process.pid, "SIGTERM");
  }

  private async stopSidecar(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const startup = this.startup;
    const runtime = this.runtime;
    await runtime?.stop();
    await startup?.catch(() => undefined);
    if (this.runtime !== runtime) await this.runtime?.stop();
    this.runtime = undefined;
    this.startup = undefined;
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

/** Whether a synchronous tool has an equivalent non-blocking operation. */
function hasUnsuffixedTool(name: string, names: ReadonlySet<string>): boolean {
  const suffix = name.endsWith("_sync") ? "_sync" : name.endsWith("sync") ? "sync" : undefined;
  return suffix ? names.has(name.slice(0, -suffix.length)) : false;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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
