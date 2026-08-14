/**
 * AppKit plugin that supervises Graphiti and republishes user-scoped MCP tools.
 *
 * @module
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  ConfigurationError,
  Plugin,
  lakebase,
  toPlugin,
  type IAppRouter,
  type PluginManifest,
  type ResourceRequirement,
} from "@databricks/appkit";
import {
  appkit as dbxAppkit,
  identity as appkitIdentity,
  plugin as appkitPlugin,
} from "@dbx-tools/appkit";
import { config as coreConfig } from "@dbx-tools/core";
import { async as asyncModule, log, object } from "@dbx-tools/shared-core";
import { createTool, type Tool } from "@mastra/core/tools";
import { MCPClient, MCPServer } from "@mastra/mcp";
import concurrently, { type Command, type ConcurrentlyResult } from "concurrently";
import type express from "express";
import {
  GRAPHITI_CONFIG_SCHEMA,
  resolveGraphitiConfig,
  type GraphitiPluginConfig,
  type ResolvedGraphitiPluginConfig,
} from "./config.ts";

const LAKEBASE_MANIFEST = appkitPlugin.data(lakebase).plugin.manifest;
const PACKAGE_VERSION = (
  createRequire(import.meta.url)("@dbx-tools/appkit-graphiti/package.json") as { version: string }
).version;
const MCP_PATH = "/api/graphiti/mcp";
const MCP_SERVER_IDLE_MS = 30 * 60 * 1000;
const MCP_SERVER_SWEEP_MS = 5 * 60 * 1000;
const SIDECAR_SHUTDOWN_GRACE_MS = 10_000;
const SIDECAR_STARTUP_TIMEOUT_MS = 10 * 60_000;
const SCOPED_TOOL_FIELDS = {
  add_memory: "group_id",
  add_triplet: "group_id",
  build_communities: "group_ids",
  get_episodes: "group_ids",
  get_status: undefined,
  search_memory_facts: "group_ids",
  search_nodes: "group_ids",
  summarize_saga: "group_id",
} as const;
const WRITE_TOOLS = new Set(["add_memory", "add_triplet", "build_communities", "summarize_saga"]);
const UNSCOPED_ARGUMENTS = [
  "center_node_uuid",
  "previous_episode_uuids",
  "saga_previous_episode_uuid",
  "source_node_uuid",
  "target_node_uuid",
  "uuid",
] as const;

interface ToolkitEntry {
  readonly __toolkitRef: true;
  pluginName: string;
  localName: string;
  def: {
    name: string;
    description: string;
    parameters: unknown;
  };
  annotations: {
    effect: "read" | "write";
    requiresUserContext: true;
  };
}

interface UserMcpServer {
  lastUsed: number;
  server: MCPServer;
}

export class GraphitiPlugin extends Plugin<GraphitiPluginConfig> {
  static manifest: PluginManifest<"graphiti"> = {
    name: "graphiti",
    displayName: "Graphiti",
    description:
      "Runs the dbx-tools Graphiti MCP sidecar with Lakebase-backed recovery and " +
      "publishes it through the App's single port with Caddy.",
    stability: "beta",
    resources: {
      required: [],
      optional: [...LAKEBASE_MANIFEST.resources.required],
    },
    config: { schema: GRAPHITI_CONFIG_SCHEMA },
  };

  static getResourceRequirements(): ResourceRequirement[] {
    return LAKEBASE_MANIFEST.resources.required.map((resource) => ({
      ...resource,
      required: true,
    }));
  }

  private readonly logger = log.logger(this);
  private commands: Command[] = [];
  private mcp?: MCPClient;
  private mcpServers = new Map<string, UserMcpServer>();
  private mcpServerSweep?: NodeJS.Timeout;
  private mcpTools: Record<string, Tool> = {};
  private resolved?: ResolvedGraphitiPluginConfig;
  private setupComplete = false;
  private startup?: Promise<void>;
  private supervision?: ConcurrentlyResult;
  private stopping = false;

  override async setup(): Promise<void> {
    this.startup = this.startSidecars().catch((error: unknown) => {
      if (this.stopping) return;
      this.logger.error("background startup failed; Graphiti remains unavailable", { error });
    });
    void this.startup;
    this.logger.info("background startup scheduled");
  }

  private async startSidecars(): Promise<void> {
    const configured = resolveGraphitiConfig(this.config);
    const [graphitiPort, litellmPort, proxyPort] = await distinctPorts(
      coreConfig.port(undefined, "DATABRICKS_APP_PORT", 8000, coreConfig.ENV_ONLY),
      configured.graphitiPort,
      configured.litellmPort,
      configured.proxyPort,
    );
    await ensureGraphitiPython(configured.python);
    this.resolved = {
      ...configured,
      graphitiPort,
      litellmPort,
      proxyPort,
    };
    this.supervision = concurrently(
      [
        {
          name: "graphiti",
          command: commandLine([this.resolved.python, "-m", "dbx_tools.graphiti", "start"]),
          env: {
            ...process.env,
            GRAPHITI_HOST: "127.0.0.1",
            GRAPHITI_PORT: String(this.resolved.graphitiPort),
            JOURNAL_NAMESPACE: this.resolved.journalNamespace,
            LITELLM_HOST: "127.0.0.1",
            LITELLM_PORT: String(this.resolved.litellmPort),
            MANAGE_LITELLM: "true",
          },
        },
        {
          name: "caddy",
          command: commandLine([
            this.resolved.python,
            "-m",
            "dbx_tools.graphiti.proxy",
            "--proxy-port",
            String(this.resolved.proxyPort),
            "--graphiti-port",
            String(this.resolved.graphitiPort),
          ]),
          env: process.env,
        },
      ],
      {
        killOthersOn: ["failure", "success"],
        killSignal: "SIGTERM",
        killTimeout: SIDECAR_SHUTDOWN_GRACE_MS,
        prefix: "name",
        prefixColors: false,
      },
    );
    this.commands = this.supervision.commands;
    void this.supervision.result.then(
      () => this.onSupervisorExit(),
      (error) => this.onSupervisorExit(error),
    );
    const supervisionFailure = this.supervision.result.then(
      () => {
        throw new Error("Graphiti sidecar supervisor exited during startup");
      },
      (error) => {
        throw error;
      },
    );
    try {
      await Promise.race([
        (async () => {
          await waitForGraphiti(graphitiPort);
          await waitForGraphiti(proxyPort);
        })(),
        supervisionFailure,
      ]);
      this.mcp = new MCPClient({
        id: `appkit-graphiti-${this.resolved.graphitiPort}`,
        servers: {
          graphiti: {
            url: new URL(`http://127.0.0.1:${this.resolved.proxyPort}/mcp`),
          },
        },
      });
      const discovered = await this.mcp.listTools();
      this.mcpTools = Object.fromEntries(
        Object.entries(discovered)
          .map(([name, tool]) => [name.replace(/^graphiti_/, ""), tool as Tool] as const)
          .filter(([name]) => name in SCOPED_TOOL_FIELDS),
      );
      const missing = Object.keys(SCOPED_TOOL_FIELDS).filter((name) => !this.mcpTools[name]);
      if (missing.length > 0) {
        throw new Error(`Graphiti did not publish required scoped tools: ${missing.join(", ")}`);
      }
    } catch (error) {
      await this.stopSidecars();
      throw error;
    }
    this.setupComplete = true;
    this.mcpServerSweep = setInterval(() => this.closeIdleMcpServers(), MCP_SERVER_SWEEP_MS);
    this.mcpServerSweep.unref();
    this.logger.info("ready", {
      graphitiPort: this.resolved.graphitiPort,
      litellmPort: this.resolved.litellmPort,
      proxyPort: this.resolved.proxyPort,
      mcpPath: MCP_PATH,
      tools: Object.keys(this.mcpTools),
    });
  }

  override injectRoutes(router: IAppRouter): void {
    for (const method of ["get", "post", "delete"] as const) {
      this.route(router, {
        name: `${method}Mcp`,
        method,
        path: "/mcp",
        handler: (request, response) => this.forwardMcp(request, response),
      });
    }
  }

  override abortActiveOperations(): void {
    super.abortActiveOperations();
    void this.mcp?.disconnect();
  }

  async shutdown(): Promise<void> {
    await this.stopSidecars();
  }

  override exports() {
    return { mcpPath: MCP_PATH };
  }

  toolkit(): Record<string, ToolkitEntry> {
    return Object.fromEntries(
      Object.entries(this.mcpTools).map(([name, tool]) => [
        name,
        {
          __toolkitRef: true as const,
          pluginName: "graphiti",
          localName: name,
          def: {
            name,
            description: tool.description,
            parameters: tool.inputSchema ?? { type: "object", properties: {} },
          },
          annotations: {
            effect: WRITE_TOOLS.has(name) ? ("write" as const) : ("read" as const),
            requiresUserContext: true as const,
          },
        },
      ]),
    );
  }

  async executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    context?: { resourceId?: string },
  ): Promise<unknown> {
    const tool = this.mcpTools[name];
    if (!tool?.execute) throw new Error(`Unknown Graphiti tool: ${name}`);
    const userId = context?.resourceId ?? executionContextUserId();
    return tool.execute(scopedArguments(name, args, userScope(userId)), {
      abortSignal: signal,
    } as never);
  }

  private async forwardMcp(request: express.Request, response: express.Response): Promise<void> {
    if (!this.resolved) {
      response.status(503).json({ error: "Graphiti is not ready" });
      return;
    }
    const userId = appkitIdentity.requestUserId(request) ?? executionContextUserId();
    const server = this.mcpServer(userId);
    await server.startHTTP({
      url: new URL(request.originalUrl, "http://app.local"),
      httpPath: MCP_PATH,
      req: request,
      res: response,
    });
  }

  private mcpServer(userId: string): MCPServer {
    const existing = this.mcpServers.get(userId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.server;
    }
    const scope = userScope(userId);
    const tools = Object.fromEntries(
      Object.entries(this.mcpTools).map(([name, tool]) => [
        name,
        createTool({
          id: name,
          description: tool.description ?? name,
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema as never } : {}),
          execute: (args: unknown, context: unknown) => {
            if (!tool.execute) throw new Error(`Graphiti tool cannot execute: ${name}`);
            return tool.execute(scopedArguments(name, args, scope), context as never);
          },
        }),
      ]),
    );
    const server = new MCPServer({
      name: "Graphiti",
      version: "1.0.0",
      tools,
    });
    this.mcpServers.set(userId, { lastUsed: Date.now(), server });
    return server;
  }

  private onSupervisorExit(error?: unknown): void {
    if (this.stopping || !this.setupComplete) return;
    this.logger.error("sidecar supervisor exited", { error });
    process.kill(process.pid, "SIGTERM");
  }

  private async stopSidecars(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.mcpServerSweep) clearInterval(this.mcpServerSweep);
    this.mcpServerSweep = undefined;
    const commands = this.commands;
    const supervision = this.supervision;
    for (const command of commands) command.kill("SIGTERM");
    const cleanup = Promise.allSettled([
      ...[...this.mcpServers.values()].map(({ server }) => server.close()),
      this.mcp?.disconnect(),
      supervision?.result,
    ]);
    const completed = await Promise.race([
      cleanup.then(() => true),
      asyncModule.sleep(SIDECAR_SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (!completed) {
      this.logger.warn("sidecars ignored SIGTERM; escalating to SIGKILL");
      for (const command of commands) command.kill("SIGKILL");
    }
    this.mcpServers.clear();
    this.mcp = undefined;
    this.mcpTools = {};
    this.commands = [];
    this.supervision = undefined;
    this.startup = undefined;
  }

  private closeIdleMcpServers(): void {
    const cutoff = Date.now() - MCP_SERVER_IDLE_MS;
    for (const [userId, entry] of this.mcpServers) {
      if (entry.lastUsed >= cutoff) continue;
      this.mcpServers.delete(userId);
      void entry.server.close().catch((error) => {
        this.logger.warn("idle MCP server close failed", { error });
      });
    }
  }
}

type ExecPython = (file: string, args: string[]) => Promise<unknown>;

/** Ensure Databricks Apps has the Python sidecar matching this Node package. */
export async function ensureGraphitiPython(
  python: string,
  run: ExecPython = (file, args) => promisify(execFile)(file, args),
): Promise<void> {
  try {
    await run(python, ["-c", "import dbx_tools.graphiti"]);
  } catch {
    try {
      await run(python, ["-m", "pip", "--version"]);
    } catch {
      await run(python, [
        "-c",
        "import urllib.request; exec(urllib.request.urlopen('https://bootstrap.pypa.io/get-pip.py').read())",
        "--user",
        "--break-system-packages",
      ]);
    }
    await run(python, [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--user",
      "--break-system-packages",
      `dbx-tools-graphiti==${PACKAGE_VERSION}`,
    ]);
  }
}

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

async function waitForGraphiti(port: number): Promise<void> {
  for await (const ready of asyncModule.poll(
    async ({ signal }) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal });
        return response.ok;
      } catch {
        return false;
      }
    },
    {
      intervalMs: 250,
      timeoutMs: SIDECAR_STARTUP_TIMEOUT_MS,
      predicate: (ready) => !ready,
    },
  )) {
    if (ready) return;
  }
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

async function distinctPorts(
  appPort: number,
  graphitiPort: number,
  litellmPort: number,
  proxyPort: number,
): Promise<[number, number, number]> {
  const ports = [appPort];
  for (const configuredPort of [graphitiPort, litellmPort, proxyPort]) {
    if (configuredPort && ports.includes(configuredPort)) {
      throw new ConfigurationError("Graphiti sidecar ports must differ from DATABRICKS_APP_PORT");
    }
    let port = configuredPort || (await availablePort());
    while (ports.includes(port)) port = await availablePort();
    ports.push(port);
  }
  return ports.slice(1) as [number, number, number];
}

function commandLine(arguments_: string[]): string {
  return arguments_.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
}
