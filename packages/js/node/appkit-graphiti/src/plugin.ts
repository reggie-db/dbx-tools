/**
 * AppKit plugin that supervises Graphiti and a Caddy single-port proxy.
 *
 * @module
 */
import { createServer } from "node:net";
import {
  Plugin,
  lakebase,
  toPlugin,
  type PluginManifest,
  type ResourceRequirement,
} from "@databricks/appkit";
import { interceptor as appkitInterceptor, plugin as appkitPlugin } from "@dbx-tools/appkit";
import { exec } from "@dbx-tools/core";
import { async as asyncModule, log } from "@dbx-tools/shared-core";
import type { Tool } from "@mastra/core/tools";
import { MCPClient } from "@mastra/mcp";
import {
  GRAPHITI_CONFIG_SCHEMA,
  resolveGraphitiConfig,
  type GraphitiPluginConfig,
  type ResolvedGraphitiPluginConfig,
} from "./config.ts";

const LAKEBASE_MANIFEST = appkitPlugin.data(lakebase).plugin.manifest;

interface ToolkitEntry {
  pluginName: string;
  localName: string;
  def: {
    name: string;
    description: string;
    parameters: unknown;
  };
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
  private children: ReturnType<typeof exec.spawn>[] = [];
  private mcp?: MCPClient;
  private mcpTools: Record<string, Tool> = {};
  private resolved?: ResolvedGraphitiPluginConfig;
  private stopping = false;

  override async setup(): Promise<void> {
    const configured = resolveGraphitiConfig(this.config);
    const graphitiPort = configured.graphitiPort || (await availablePort());
    let litellmPort = configured.litellmPort || (await availablePort());
    while (litellmPort === graphitiPort) litellmPort = await availablePort();
    this.resolved = {
      ...configured,
      graphitiPort,
      litellmPort,
    };
    if (!process.env.LAKEBASE_ENDPOINT && !process.env.PGHOST) {
      throw new Error(
        "Graphiti requires Lakebase; register lakebase() before graphiti() and bind its Postgres resource",
      );
    }
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => this.stopGraphiti());
    }
    const supervisor = appkitInterceptor.createInterceptorContext({});
    supervisor.context.onTeardown(() => this.stopGraphiti());
    const graphiti = exec.spawn(this.resolved.python, ["-m", "dbx_tools.graphiti", "start"], {
      env: {
        ...process.env,
        GRAPHITI_HOST: "127.0.0.1",
        GRAPHITI_PORT: String(this.resolved.graphitiPort),
        JOURNAL_NAMESPACE: this.resolved.journalNamespace,
        LITELLM_HOST: "127.0.0.1",
        LITELLM_PORT: String(this.resolved.litellmPort),
        MANAGE_LITELLM: "true",
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    const caddy = exec.spawn(
      this.resolved.python,
      [
        "-m",
        "dbx_tools.graphiti.proxy",
        "--public-port",
        String(this.resolved.publicPort),
        "--app-port",
        String(this.resolved.appPort),
        "--graphiti-port",
        String(this.resolved.graphitiPort),
        "--route-prefix",
        this.resolved.routePrefix,
      ],
      {
        env: process.env,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    this.children = [graphiti, caddy];
    for (const child of this.children) supervisor.context.bindProcess(child);
    await waitForGraphiti(this.resolved.graphitiPort);
    this.mcp = new MCPClient({
      id: `appkit-graphiti-${this.resolved.graphitiPort}`,
      servers: {
        graphiti: {
          url: new URL(`http://127.0.0.1:${this.resolved.graphitiPort}/mcp`),
        },
      },
    });
    const discovered = await this.mcp.listTools();
    this.mcpTools = Object.fromEntries(
      Object.entries(discovered).map(([name, tool]) => [
        name.replace(/^graphiti_/, ""),
        tool as Tool,
      ]),
    );
    this.logger.info("ready", {
      appPort: this.resolved.appPort,
      graphitiPort: this.resolved.graphitiPort,
      litellmPort: this.resolved.litellmPort,
      publicPort: this.resolved.publicPort,
      mcpPath: `${this.resolved.routePrefix}/mcp/`,
      tools: Object.keys(this.mcpTools),
    });
  }

  override abortActiveOperations(): void {
    super.abortActiveOperations();
    this.stopGraphiti();
    void this.mcp?.disconnect();
    this.mcp = undefined;
    this.mcpTools = {};
    for (const child of this.children) {
      if (!child.killed) child.kill("SIGTERM");
    }
    this.children = [];
  }

  override exports() {
    const resolved = this.resolved ?? resolveGraphitiConfig(this.config);
    return {
      appPort: resolved.appPort,
      graphitiPort: resolved.graphitiPort,
      litellmPort: resolved.litellmPort,
      mcpPath: `${resolved.routePrefix}/mcp/`,
      publicPort: resolved.publicPort,
      routePrefix: resolved.routePrefix,
    };
  }

  toolkit(): Record<string, ToolkitEntry> {
    return Object.fromEntries(
      Object.entries(this.mcpTools).map(([name, tool]) => [
        name,
        {
          pluginName: "graphiti",
          localName: name,
          def: {
            name,
            description: tool.description,
            parameters: tool.inputSchema ?? { type: "object", properties: {} },
          },
        },
      ]),
    );
  }

  async executeAgentTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const tool = this.mcpTools[name];
    if (!tool?.execute) throw new Error(`Unknown Graphiti tool: ${name}`);
    return tool.execute(args, { abortSignal: signal } as never);
  }

  private stopGraphiti(): void {
    if (this.stopping || !this.resolved) return;
    this.stopping = true;
    void exec.spawn(this.resolved.python, ["-m", "dbx_tools.graphiti", "down"], {
      env: process.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
  }
}

export const graphiti = toPlugin(GraphitiPlugin);

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
      timeoutMs: 60_000,
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
