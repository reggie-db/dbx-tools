/**
 * AppKit plugin that supervises Graphiti and republishes user-scoped MCP tools.
 *
 * @module
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { resolve as resolvePath } from "node:path";
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
import type {
  AgentToolDefinition,
  ToolkitEntry,
  ToolkitOptions,
  ToolAnnotations,
  ToolProvider,
} from "@databricks/appkit/beta";
import {
  appkit as dbxAppkit,
  identity as appkitIdentity,
  plugin as appkitPlugin,
  toolkit as appkitToolkit,
} from "@dbx-tools/appkit";
import { config as coreConfig } from "@dbx-tools/core";
import { ensureRustReleaseBinary, rustReleaseBinaryCommand } from "@dbx-tools/rust-binary";
import { async as asyncModule, log, object } from "@dbx-tools/shared-core";
import { createTool, type Tool } from "@mastra/core/tools";
import { MCPClient, MCPServer } from "@mastra/mcp";
import concurrently, { type Command, type ConcurrentlyResult } from "concurrently";
import type express from "express";
import { GRAPHITI_PYTHON_VERSION } from "./_python-runtime.ts";
import {
  GRAPHITI_CONFIG_SCHEMA,
  resolveGraphitiConfig,
  type GraphitiPluginConfig,
  type ResolvedGraphitiPluginConfig,
} from "./config.ts";

const LAKEBASE_MANIFEST = appkitPlugin.data(lakebase).plugin.manifest;
const MODEL_PROXY_RELEASE_BINARY = rustReleaseBinaryCommand("model-proxy");
const MCP_PATH = "/api/graphiti/mcp";
const MCP_SERVER_IDLE_MS = 30 * 60 * 1000;
const MCP_SERVER_SWEEP_MS = 5 * 60 * 1000;
const MCP_TOOL_DISCOVERY_TIMEOUT_MS = 60_000;
const MCP_TOOL_DISCOVERY_RETRY_MS = 250;
const SIDECAR_SHUTDOWN_GRACE_MS = 10_000;
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

interface UserMcpServer {
  lastUsed: number;
  server: MCPServer;
}

export class GraphitiPlugin extends Plugin<GraphitiPluginConfig> implements ToolProvider {
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
  private toolsReady?: Promise<void>;

  override async setup(): Promise<void> {
    this.startup = this.startSidecars();
    void this.startup.catch((error: unknown) => {
      if (this.stopping) return;
      this.logger.error("background startup failed", { error });
      process.kill(process.pid, "SIGTERM");
    });
    void this.startup;
    this.logger.info("background startup scheduled");
  }

  private async startSidecars(): Promise<void> {
    const configured = resolveGraphitiConfig(this.config);
    const [graphitiPort, modelProxyPort, proxyPort] = await distinctPorts(
      coreConfig.port(undefined, "DATABRICKS_APP_PORT", 8000, coreConfig.ENV_ONLY),
      configured.graphitiPort,
      configured.modelProxyPort,
      configured.proxyPort,
    );
    await ensureGraphitiPython(configured.python);
    const modelProxyCommand = await ensureGraphitiModelProxy();
    this.resolved = {
      ...configured,
      graphitiPort,
      modelProxyPort,
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
            MANAGE_MODEL_PROXY: "true",
            MODEL_PROXY_COMMAND: modelProxyCommand,
            MODEL_PROXY_HOST: "127.0.0.1",
            MODEL_PROXY_PORT: String(this.resolved.modelProxyPort),
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
    this.setupComplete = true;
    void this.supervision.result.then(
      () => this.onSupervisorExit(),
      (error) => this.onSupervisorExit(error),
    );
    this.mcpServerSweep = setInterval(() => this.closeIdleMcpServers(), MCP_SERVER_SWEEP_MS);
    this.mcpServerSweep.unref();
    this.logger.info("sidecars launched", {
      graphitiPort: this.resolved.graphitiPort,
      modelProxyPort: this.resolved.modelProxyPort,
      proxyPort: this.resolved.proxyPort,
      mcpPath: MCP_PATH,
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

  async toolkit(options?: ToolkitOptions): Promise<Record<string, ToolkitEntry>> {
    await this.ensureMcpTools();
    return appkitToolkit.entries("graphiti", this.getAgentTools(), options);
  }

  getAgentTools(): AgentToolDefinition[] {
    return Object.entries(this.mcpTools).map(([name, tool]) => {
      const annotations = toolAnnotations(name);
      return {
        name,
        description: requiredToolDescription(name, tool),
        parameters: requiredToolSchema(name, tool),
        annotations,
      };
    });
  }

  async executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    context?: { resourceId?: string },
  ): Promise<unknown> {
    await this.ensureMcpTools(signal);
    const tool = this.mcpTools[name];
    if (!tool?.execute) throw new Error(`Unknown Graphiti tool: ${name}`);
    const userId = context?.resourceId ?? executionContextUserId();
    return tool.execute(scopedArguments(name, args, userScope(userId)), {
      abortSignal: signal,
    } as never);
  }

  private async forwardMcp(request: express.Request, response: express.Response): Promise<void> {
    await this.ensureMcpTools();
    const userId = appkitIdentity.requestUserId(request) ?? executionContextUserId();
    const server = this.mcpServer(userId);
    await server.startHTTP({
      url: new URL(request.originalUrl, "http://app.local"),
      httpPath: MCP_PATH,
      req: request,
      res: response,
    });
  }

  private async ensureMcpTools(signal?: AbortSignal): Promise<void> {
    if (Object.keys(this.mcpTools).length > 0) return;
    this.toolsReady ??= this.discoverMcpTools().catch((error: unknown) => {
      this.toolsReady = undefined;
      throw error;
    });
    await abortable(this.toolsReady, signal);
  }

  private async discoverMcpTools(): Promise<void> {
    if (!this.startup) throw new Error("Graphiti sidecar startup has not been scheduled");
    await this.startup;
    if (!this.resolved) throw new Error("Graphiti sidecars did not launch");
    this.mcp ??= new MCPClient({
      id: `appkit-graphiti-${this.resolved.graphitiPort}`,
      servers: {
        graphiti: { url: new URL(`http://127.0.0.1:${this.resolved.proxyPort}/mcp`) },
      },
    });
    const deadline = Date.now() + MCP_TOOL_DISCOVERY_TIMEOUT_MS;
    let lastError: unknown;
    while (!this.stopping && Date.now() < deadline) {
      try {
        const discovered = await this.mcp.listTools();
        const tools = Object.fromEntries(
          Object.entries(discovered)
            .map(([name, tool]) => [name.replace(/^graphiti_/, ""), tool as Tool] as const)
            .filter(([name]) => name in SCOPED_TOOL_FIELDS),
        );
        const missing = Object.keys(SCOPED_TOOL_FIELDS).filter((name) => !tools[name]);
        if (missing.length > 0) {
          throw new Error(`Graphiti did not publish required scoped tools: ${missing.join(", ")}`);
        }
        for (const [name, tool] of Object.entries(tools)) {
          requiredToolDescription(name, tool);
          requiredToolSchema(name, tool);
        }
        this.mcpTools = tools;
        return;
      } catch (error) {
        lastError = error;
        await asyncModule.sleep(MCP_TOOL_DISCOVERY_RETRY_MS);
      }
    }
    if (this.stopping) throw new Error("Graphiti stopped before MCP tools were ready");
    throw new Error("Graphiti MCP tool discovery timed out", { cause: lastError });
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
    this.toolsReady = undefined;
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
    await run(python, [
      "-c",
      `import importlib.metadata; assert importlib.metadata.version('dbx-tools-graphiti') == '${GRAPHITI_PYTHON_VERSION}'`,
    ]);
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
      "--upgrade",
      "--user",
      "--break-system-packages",
      `dbx-tools-graphiti==${GRAPHITI_PYTHON_VERSION}`,
    ]);
  }
}

/** Install the model proxy release binary used by the Python sidecar. */
export async function ensureGraphitiModelProxy(
  install: typeof ensureRustReleaseBinary = ensureRustReleaseBinary,
): Promise<string> {
  const installed = await install(MODEL_PROXY_RELEASE_BINARY);
  return resolvePath(installed.path);
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

function toolAnnotations(name: string): ToolAnnotations {
  return {
    effect: WRITE_TOOLS.has(name) ? "write" : "read",
    requiresUserContext: true,
  };
}

function requiredToolDescription(name: string, tool: Tool): string {
  const description = tool.description?.trim();
  if (!description) throw new Error(`Graphiti tool ${name} did not publish a description`);
  return description;
}

function requiredToolSchema(name: string, tool: Tool): AgentToolDefinition["parameters"] {
  const schema = tool.inputSchema as
    | {
        "~standard"?: {
          jsonSchema?: {
            input(options: { target: "draft-07" }): unknown;
          };
        };
      }
    | undefined;
  const parameters = schema?.["~standard"]?.jsonSchema?.input({ target: "draft-07" });
  if (!object.isRecord(parameters)) {
    throw new Error(`Graphiti tool ${name} did not publish a JSON input schema`);
  }
  return parameters as AgentToolDefinition["parameters"];
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

async function distinctPorts(
  appPort: number,
  graphitiPort: number,
  modelProxyPort: number,
  proxyPort: number,
): Promise<[number, number, number]> {
  const ports = [appPort];
  for (const configuredPort of [graphitiPort, modelProxyPort, proxyPort]) {
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
