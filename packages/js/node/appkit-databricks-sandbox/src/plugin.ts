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
  USER_EMAIL_HEADER,
  USER_ID_HEADER,
  appkit,
  pluginRegistry,
  toolkitEntries,
  ToolRegistryPlugin,
  type AgentToolExecutionContext,
} from "@dbx-tools/appkit";
import {
  addSshRouteRequestSchema,
  createSshMachineRequestSchema,
  removeSshRouteRequestSchema,
  sshCommandRequestSchema,
  sshMachineActionSchema,
  sshMachineServiceActionSchema,
  type AddSshRouteRequest,
  type CreateSshMachineRequest,
  type SshCommandRequest,
  type SshMachineServiceAction,
} from "@dbx-tools/shared-databricks-sandbox";
import type { Application, Request } from "express";
import type { JSONSchema7 } from "json-schema";
import { z } from "zod";
import { resolveSshPluginConfig, SshPluginConfigSchema, type SshPluginConfig } from "./config.ts";
import { SshRuntime } from "./runtime.ts";

interface ServerExtension {
  addExtension(fn: (application: Application) => void): void;
  getServer(): HttpServer;
}

interface UpgradeIdentityGate {
  isProtectedHost(headers: Headers): boolean;
  session(headers: Headers): Promise<string | undefined>;
}

const SSH_CONFIG_SCHEMA = z.toJSONSchema(SshPluginConfigSchema) as JSONSchema7;

/** AppKit plugin for Databricks Sandbox lifecycle, SSH, and route operations. */
export class AppKitSshPlugin extends ToolRegistryPlugin<SshPluginConfig> {
  static manifest = {
    name: "databricks-sandbox",
    displayName: "Sandboxes",
    description:
      "Creates and manages Databricks Sandboxes over REST and SSH, with remote web routing and Mastra tools.",
    stability: "beta",
    resources: { required: [], optional: [] },
    config: { schema: SSH_CONFIG_SCHEMA },
  } satisfies PluginManifest<"databricks-sandbox">;

  readonly runtime: SshRuntime;
  private mounted = false;
  private httpServer?: HttpServer;
  private upgradeAttachTimer?: ReturnType<typeof setTimeout>;
  private upgradeIdentityGate?: UpgradeIdentityGate;
  private readonly upgradeHandler = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    void this.handleUpgrade(request, socket, head);
  };

  constructor(config: SshPluginConfig = {}) {
    super(config);
    this.runtime = config.runtime ?? new SshRuntime(resolveSshPluginConfig(config));
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
      this.upgradeIdentityGate = resolveUpgradeIdentityGate(
        this.context?.getPlugins().get("authGate"),
      );
      server.addExtension((application) => application.use(this.runtime.routes.middleware()));
      this.mounted = true;
      this.attachUpgradeHandler(server);
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
      name: "createMachine",
      method: "post",
      path: "/machines",
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = createSshMachineRequestSchema.parse(req.body ?? {});
        res.json(
          await this.withRequestAuth(
            req,
            "createMachine",
            (plugin) => plugin.createMachine(userId, input),
            () => this.runtime.createMachine(createWorkspaceClient(), userId, input),
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
      name: "deleteMachine",
      method: "delete",
      path: "/machines/:machineId",
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = sshMachineActionSchema.parse({ machineId: req.params.machineId });
        res.json(
          await this.withRequestAuth(
            req,
            "deleteMachine",
            (plugin) => plugin.deleteMachine(userId, input.machineId),
            () => this.runtime.deleteMachine(createWorkspaceClient(), userId, input.machineId),
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

  async createMachine(userId: string, input: CreateSshMachineRequest = {}) {
    return this.runtime.createMachine(this.workspaceClient(), userId, input);
  }

  async startMachine(userId: string, machineId: string) {
    return this.runtime.startMachine(this.workspaceClient(), userId, machineId);
  }

  async stopMachine(userId: string, machineId: string) {
    return this.runtime.stopMachine(this.workspaceClient(), userId, machineId);
  }

  async deleteMachine(userId: string, machineId: string) {
    return this.runtime.deleteMachine(this.workspaceClient(), userId, machineId);
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
      createMachine: (userId: string, input: CreateSshMachineRequest) =>
        this.createMachine(userId, input),
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
    if (this.upgradeAttachTimer) clearTimeout(this.upgradeAttachTimer);
    this.upgradeAttachTimer = undefined;
    this.httpServer?.off("upgrade", this.upgradeHandler);
    this.httpServer = undefined;
    await this.runtime.close();
  }

  private attachUpgradeHandler(server: ServerExtension): void {
    if (this.httpServer || this.upgradeAttachTimer) return;
    try {
      this.httpServer = server.getServer();
      this.httpServer.on("upgrade", this.upgradeHandler);
    } catch {
      this.upgradeAttachTimer = setTimeout(() => {
        this.upgradeAttachTimer = undefined;
        this.attachUpgradeHandler(server);
      }, 10);
      this.upgradeAttachTimer.unref?.();
    }
  }

  private async handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (!this.runtime.routes.canHandleUpgrade(path)) return;
    const gate = this.upgradeIdentityGate;
    if (gate) {
      const headers = requestHeaders(request);
      if (gate.isProtectedHost(headers)) {
        delete request.headers[USER_ID_HEADER];
        delete request.headers[USER_EMAIL_HEADER];
        const userId = await gate.session(headers);
        if (!userId) {
          socket.destroy();
          return;
        }
        request.headers[USER_ID_HEADER] = userId;
        request.headers[USER_EMAIL_HEADER] = userId;
      }
    }
    if (!this.runtime.routes.handleUpgrade(request, socket, head)) socket.destroy();
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
        description:
          "List the current user's Databricks Sandboxes. Always check this first and prefer an existing Sandbox unless the user explicitly requests another.",
        schema: z.object({}).strict(),
        annotations: { effect: "read", requiresUserContext: true },
        execute: (_args, signal) =>
          execute("listMachines", (client, resolvedUserId) =>
            this.runtime.listMachines(client, resolvedUserId, signal),
          ),
      }),
      create_ssh_machine: defineTool({
        description:
          "Create a new Databricks Sandbox for the current user only when they explicitly request a new Sandbox or no existing Sandbox meets the request.",
        schema: createSshMachineRequestSchema,
        annotations: { effect: "write", requiresUserContext: true },
        execute: (input, signal) =>
          execute("createMachine", (client, resolvedUserId) =>
            this.runtime.createMachine(client, resolvedUserId, input, signal),
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
      delete_ssh_machine: defineTool({
        description: "Permanently delete one Databricks Sandbox owned by the current user.",
        schema: sshMachineActionSchema,
        annotations: { effect: "write", requiresUserContext: true },
        execute: (input, signal) =>
          execute("deleteMachine", (client, resolvedUserId) =>
            this.runtime.deleteMachine(client, resolvedUserId, input.machineId, signal),
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
        description: "Start the built-in DinoTTY terminal or Glances health service.",
        schema: sshMachineServiceActionSchema,
        annotations: { effect: "write", requiresUserContext: true },
        execute: (input, signal) =>
          execute("startMachineService", (client, resolvedUserId) =>
            this.runtime.startService(client, resolvedUserId, input, signal),
          ),
      }),
      add_ssh_route: defineTool({
        description:
          "Expose a Sandbox loopback HTTP port at an AppKit path. Never return localhost or a direct Sandbox URL. The service must either tolerate the registered prefix or use stripPrefix; WebSockets must use the same public route and standard HTTP Upgrade.",
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

function resolveUpgradeIdentityGate(plugin: unknown): UpgradeIdentityGate | undefined {
  const exports = (plugin as { exports?: () => unknown } | undefined)?.exports?.();
  if (
    typeof (exports as UpgradeIdentityGate | undefined)?.isProtectedHost !== "function" ||
    typeof (exports as UpgradeIdentityGate | undefined)?.session !== "function"
  ) {
    return undefined;
  }
  return exports as UpgradeIdentityGate;
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

/** AppKit plugin factory for {@link AppKitSshPlugin}. */
export const databricksSandbox = toPlugin(AppKitSshPlugin);
