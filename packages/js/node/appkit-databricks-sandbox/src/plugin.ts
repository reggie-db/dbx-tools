import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import {
  createWorkspaceClient,
  lakebase,
  toPlugin,
  type IAppRouter,
  type PluginManifest,
  type WorkspaceClient,
} from "@databricks/appkit";
import {
  defineTool,
  executeFromRegistry,
  type ToolkitEntry,
  type ToolkitOptions,
  type ToolRegistry,
} from "@databricks/appkit/beta";
import {
  ACCESS_TOKEN_HEADER,
  appkit,
  pluginRegistry,
  toolkitEntries,
  ToolRegistryPlugin,
  type AgentToolExecutionContext,
} from "@dbx-tools/appkit";
import {
  addSshRouteRequestSchema,
  removeSshRouteRequestSchema,
  sshCommandRequestSchema,
  sshMachineActionSchema,
  sshMachineServiceActionSchema,
  type AddSshRouteRequest,
  type SshCommandRequest,
  type SshMachineServiceAction,
} from "@dbx-tools/shared-databricks-sandbox";
import type { Application, Request } from "express";
import type { JSONSchema7 } from "json-schema";
import { z } from "zod";
import { resolveSshPluginConfig, SshPluginConfigSchema, type SshPluginConfig } from "./config.ts";
import { SshRuntime } from "./runtime.ts";
import { SandboxTerminalServer, terminalDimensions } from "./terminal.ts";

interface ServerExtension {
  addExtension(fn: (application: Application) => void): void;
  getServer(): HttpServer;
}

const SSH_CONFIG_SCHEMA = z.toJSONSchema(SshPluginConfigSchema) as JSONSchema7;

/** AppKit plugin for existing Databricks Sandbox lifecycle, SSH, and route operations. */
export class AppKitSshPlugin extends ToolRegistryPlugin<SshPluginConfig> {
  static manifest = {
    name: "databricks-sandbox",
    displayName: "Sandboxes",
    description:
      "Discovers and manages existing Databricks Sandboxes over REST and SSH, with remote web routing and Mastra tools.",
    stability: "beta",
    resources: { required: [], optional: [] },
    config: { schema: SSH_CONFIG_SCHEMA },
  } satisfies PluginManifest<"databricks-sandbox">;

  readonly runtime: SshRuntime;
  private readonly terminal: SandboxTerminalServer;
  private mounted = false;
  private httpServer?: HttpServer;
  private readonly upgradeHandler = (request: IncomingMessage, socket: Socket, head: Buffer) =>
    this.runtime.routes.handleUpgrade(request, socket, head);

  constructor(config: SshPluginConfig = {}) {
    super(config);
    this.runtime = config.runtime ?? new SshRuntime(resolveSshPluginConfig(config));
    this.terminal = new SandboxTerminalServer();
  }

  protected get toolRegistry(): ToolRegistry {
    return this.createToolRegistry();
  }

  override async setup(): Promise<void> {
    this.context?.onLifecycle("setup:complete", async () => {
      const pool = pluginRegistry.instance(this.context, lakebase)?.exports().pool;
      await this.runtime.initializeOwnership(pool);
      const server = this.context?.getPlugins().get("server") as ServerExtension | undefined;
      if (!server || this.mounted) return;
      server.addExtension((application) => application.use(this.runtime.routes.middleware()));
      this.mounted = true;
    });
    this.context?.onLifecycle("server:ready", () => {
      const server = this.context?.getPlugins().get("server") as ServerExtension | undefined;
      if (!server || this.httpServer) return;
      this.httpServer = server.getServer();
      this.httpServer.on("upgrade", this.upgradeHandler);
    });
  }

  override injectRoutes(router: IAppRouter): void {
    this.route(router, {
      name: "machines",
      method: "get",
      path: "/machines",
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        res.json(
          await this.withRequestAuth(
            req,
            "listMachines",
            (plugin) => plugin.listMachines(userId),
            () => this.runtime.listMachines(createWorkspaceClient(), userId),
          ),
        );
      },
    });
    this.route(router, {
      name: "startMachine",
      method: "post",
      path: "/machines/:machineId/start",
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = sshMachineActionSchema.parse({ machineId: req.params.machineId });
        res.json(
          await this.withRequestAuth(
            req,
            "startMachine",
            (plugin) => plugin.startMachine(userId, input.machineId),
            () => this.runtime.startMachine(createWorkspaceClient(), userId, input.machineId),
          ),
        );
      },
    });
    this.route(router, {
      name: "stopMachine",
      method: "post",
      path: "/machines/:machineId/stop",
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = sshMachineActionSchema.parse({ machineId: req.params.machineId });
        res.json(
          await this.withRequestAuth(
            req,
            "stopMachine",
            (plugin) => plugin.stopMachine(userId, input.machineId),
            () => this.runtime.stopMachine(createWorkspaceClient(), userId, input.machineId),
          ),
        );
      },
    });
    this.route(router, {
      name: "startMachineService",
      method: "post",
      path: "/machines/:machineId/services/:service/start",
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = sshMachineServiceActionSchema.parse({
          machineId: req.params.machineId,
          service: req.params.service,
        });
        res.json(
          await this.withRequestAuth(
            req,
            "startMachineService",
            (plugin) => plugin.startMachineService(userId, input),
            () => this.runtime.startService(createWorkspaceClient(), userId, input),
          ),
        );
      },
    });
    this.route(router, {
      name: "executeCommand",
      method: "post",
      path: "/machines/:machineId/commands",
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = sshCommandRequestSchema.parse({
          ...req.body,
          machineId: req.params.machineId,
        });
        res.json(
          await this.withRequestAuth(
            req,
            "executeCommand",
            (plugin) => plugin.executeCommand(userId, input),
            () => this.runtime.execute(createWorkspaceClient(), userId, input),
          ),
        );
      },
    });
    this.route(router, {
      name: "terminalStream",
      method: "post",
      path: "/machines/:machineId/terminal/stream",
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const machineId = routeParam(req.params.machineId);
        const client = await this.withRequestAuth(
          req,
          "openTerminal",
          async (plugin) => {
            const workspace = plugin.workspaceClient();
            await plugin.runtime.prepareMachine(workspace, userId, machineId);
            return workspace;
          },
          async () => {
            const workspace = createWorkspaceClient();
            await this.runtime.prepareMachine(workspace, userId, machineId);
            return workspace;
          },
        );
        await this.terminal.open(client, userId, machineId, res, terminalDimensions(req.query));
      },
    });
    this.route(router, {
      name: "terminalInput",
      method: "post",
      path: "/terminal/sessions/:sessionId/input",
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const data = z.object({ data: z.string() }).parse(req.body).data;
        const accepted = this.terminal.input(routeParam(req.params.sessionId), userId, data);
        res.status(accepted ? 204 : 404).end();
      },
    });
    this.route(router, {
      name: "machineStats",
      method: "get",
      path: "/machines/:machineId/stats",
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const machineId = routeParam(req.params.machineId);
        res.json(
          await this.withRequestAuth(
            req,
            "machineStats",
            (plugin) => plugin.runtime.stats(plugin.workspaceClient(), userId, machineId),
            () => this.runtime.stats(createWorkspaceClient(), userId, machineId),
          ),
        );
      },
    });
    this.route(router, {
      name: "closeTerminal",
      method: "delete",
      path: "/terminal/sessions/:sessionId",
      handler: async (req, res) => {
        const closed = this.terminal.closeSession(
          routeParam(req.params.sessionId),
          this.resolveUserId(req),
        );
        res.status(closed ? 204 : 404).end();
      },
    });
    this.route(router, {
      name: "routes",
      method: "get",
      path: "/routes",
      handler: async (req, res) => {
        res.json({ routes: this.runtime.routeList(this.resolveUserId(req)) });
      },
    });
    this.route(router, {
      name: "addRoute",
      method: "post",
      path: "/routes",
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = addSshRouteRequestSchema.parse(req.body);
        res.json({
          route: await this.withRequestAuth(
            req,
            "addRoute",
            (plugin) => plugin.addRoute(userId, input),
            () => this.runtime.addRoute(createWorkspaceClient(), userId, input),
          ),
        });
      },
    });
    this.route(router, {
      name: "removeRoute",
      method: "delete",
      path: "/routes/:routeId",
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = removeSshRouteRequestSchema.parse({ routeId: req.params.routeId });
        res.json({ removed: await this.runtime.removeRoute(userId, input.routeId) });
      },
    });
  }

  clientConfig(): Record<string, unknown> {
    return {
      routePrefix: this.runtime.config.routePrefix,
      defaultRemotePort: this.runtime.config.defaultRemotePort,
    };
  }

  async listMachines(userId: string) {
    return this.runtime.listMachines(this.workspaceClient(), userId);
  }

  async startMachine(userId: string, machineId: string) {
    return this.runtime.startMachine(this.workspaceClient(), userId, machineId);
  }

  async stopMachine(userId: string, machineId: string) {
    return this.runtime.stopMachine(this.workspaceClient(), userId, machineId);
  }

  async executeCommand(userId: string, input: SshCommandRequest) {
    return this.runtime.execute(this.workspaceClient(), userId, input);
  }

  async startMachineService(userId: string, input: SshMachineServiceAction) {
    return this.runtime.startService(this.workspaceClient(), userId, input);
  }

  async addRoute(userId: string, input: AddSshRouteRequest) {
    return this.runtime.addRoute(this.workspaceClient(), userId, input);
  }

  toolkit(options?: ToolkitOptions): Record<string, ToolkitEntry> {
    return toolkitEntries.entries("databricks-sandbox", this.getAgentTools(), options);
  }

  override executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    context?: AgentToolExecutionContext,
  ): Promise<unknown> {
    return executeFromRegistry(
      this.createToolRegistry(context?.resourceId, this.executionWorkspaceClient()),
      name,
      args,
      signal,
    );
  }

  exports() {
    return {
      listMachines: (userId: string) => this.listMachines(userId),
      startMachine: (userId: string, machineId: string) => this.startMachine(userId, machineId),
      stopMachine: (userId: string, machineId: string) => this.stopMachine(userId, machineId),
      executeCommand: (userId: string, input: SshCommandRequest) =>
        this.executeCommand(userId, input),
      startMachineService: (userId: string, input: SshMachineServiceAction) =>
        this.startMachineService(userId, input),
      addRoute: (userId: string, input: AddSshRouteRequest) => this.addRoute(userId, input),
      removeRoute: (userId: string, routeId: string) => this.runtime.removeRoute(userId, routeId),
      assignMachine: (userId: string, machineId: string) =>
        this.runtime.assignMachine(this.workspaceClient(), userId, machineId),
      unassignMachine: (userId: string, machineId: string) =>
        this.runtime.unassignMachine(this.workspaceClient(), userId, machineId),
      toolkit: (options?: ToolkitOptions) => this.toolkit(options),
    };
  }

  async shutdown(): Promise<void> {
    this.httpServer?.off("upgrade", this.upgradeHandler);
    this.httpServer = undefined;
    await this.terminal.close();
    await this.runtime.close();
  }

  private async withRequestAuth<T>(
    request: Request,
    operation: string,
    asUser: (plugin: AppKitSshPlugin) => Promise<T>,
    asServicePrincipal: () => Promise<T>,
  ): Promise<T> {
    const userId = this.resolveUserId(request);
    const tokenPresent = Boolean(request.header(ACCESS_TOKEN_HEADER)?.trim());
    return this.runtime.withAuthFallback(
      { operation, transport: "http", userId, tokenPresent },
      {
        user: () => asUser(this.asUser(request)),
        servicePrincipal: asServicePrincipal,
      },
    );
  }

  private workspaceClient(): WorkspaceClient {
    return (
      (appkit.tryGetExecutionContext()?.client as WorkspaceClient | undefined) ??
      createWorkspaceClient()
    );
  }

  private executionWorkspaceClient(): WorkspaceClient | undefined {
    return appkit.tryGetExecutionContext()?.client as WorkspaceClient | undefined;
  }

  private createToolRegistry(userId?: string, userClient?: WorkspaceClient): ToolRegistry {
    const identity = () => userId ?? this.executionUserId();
    const execute = <T>(
      operation: string,
      action: (client: WorkspaceClient, userId: string) => Promise<T>,
    ): Promise<T> => {
      const resolvedUserId = identity();
      const resolvedUserClient = userClient ?? this.executionWorkspaceClient();
      return this.runtime.withAuthFallback(
        { operation, transport: "agent-tool", userId: resolvedUserId },
        {
          ...(resolvedUserClient ? { user: () => action(resolvedUserClient, resolvedUserId) } : {}),
          servicePrincipal: () => action(createWorkspaceClient(), resolvedUserId),
        },
      );
    };
    return {
      list_ssh_machines: defineTool({
        description: "List existing Databricks Sandbox SSH machines without creating one.",
        schema: z.object({}).strict(),
        annotations: { effect: "read", requiresUserContext: true },
        execute: (_args, signal) =>
          execute("listMachines", (client, resolvedUserId) =>
            this.runtime.listMachines(client, resolvedUserId, signal),
          ),
      }),
      start_ssh_machine: defineTool({
        description: "Start an existing SSH machine and connect the AppKit transport.",
        schema: sshMachineActionSchema,
        annotations: { effect: "write", requiresUserContext: true },
        execute: (input, signal) =>
          execute("startMachine", (client, resolvedUserId) =>
            this.runtime.startMachine(client, resolvedUserId, input.machineId, signal),
          ),
      }),
      stop_ssh_machine: defineTool({
        description: "Stop an existing SSH machine.",
        schema: sshMachineActionSchema,
        annotations: { effect: "write", requiresUserContext: true },
        execute: (input, signal) =>
          execute("stopMachine", (client, resolvedUserId) =>
            this.runtime.stopMachine(client, resolvedUserId, input.machineId, signal),
          ),
      }),
      execute_ssh_command: defineTool({
        description: "Execute a command on an existing SSH machine.",
        schema: sshCommandRequestSchema,
        annotations: { effect: "write", requiresUserContext: true },
        execute: (input, signal) =>
          execute("executeCommand", (client, resolvedUserId) =>
            this.runtime.execute(client, resolvedUserId, input, signal),
          ),
      }),
      start_ssh_machine_service: defineTool({
        description: "Prepare the built-in terminal or health viewer for a Sandbox.",
        schema: sshMachineServiceActionSchema,
        annotations: { effect: "write", requiresUserContext: true },
        execute: (input, signal) =>
          execute("startMachineService", (client, resolvedUserId) =>
            this.runtime.startService(client, resolvedUserId, input, signal),
          ),
      }),
      add_ssh_route: defineTool({
        description: "Expose a remote HTTP port beneath the AppKit SSH route prefix.",
        schema: addSshRouteRequestSchema,
        annotations: { effect: "write", requiresUserContext: true },
        execute: async (input, signal) => ({
          route: await execute("addRoute", (client, resolvedUserId) =>
            this.runtime.addRoute(client, resolvedUserId, input, signal),
          ),
        }),
      }),
      remove_ssh_route: defineTool({
        description: "Remove one forwarded AppKit SSH route owned by the current user.",
        schema: removeSshRouteRequestSchema,
        annotations: { effect: "write", requiresUserContext: true },
        execute: async (input) => ({
          removed: await this.runtime.removeRoute(identity(), input.routeId),
        }),
      }),
    };
  }

  private executionUserId(): string {
    const context = appkit.tryGetExecutionContext();
    if (!context) throw new Error("SSH tools require an AppKit execution context");
    return "userId" in context ? context.userId : context.serviceUserId;
  }
}

/** AppKit plugin factory for {@link AppKitSshPlugin}. */
export const databricksSandbox = toPlugin(AppKitSshPlugin);

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? (value[0] ?? "") : value;
}
