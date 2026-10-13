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
  lakebaseResolver,
  pluginRegistry,
  toolkitEntries,
  toolOperations,
  ToolRegistryPlugin,
  type AgentToolExecutionContext,
} from "@dbx-tools/appkit";
import {
  addSshProjectOperationSchema,
  createSshMachineOperationSchema,
  deleteSshMachineOperationSchema,
  executeSshCommandOperationSchema,
  getSshMachineServiceLogsOperationSchema,
  listSshMachinesOperationSchema,
  listSshProjectsOperationSchema,
  openSshProjectTerminalOperationSchema,
  removeSshProjectOperationSchema,
  resetSshProjectOperationSchema,
  SSH_MACHINE_SERVICES,
  SSH_PLUGIN_NAME,
  SSH_ROUTES,
  sshProjectActionSchema,
  sshMachineServiceLogsRequestSchema,
  startSshMachineOperationSchema,
  startSshMachineServiceOperationSchema,
  stopSshMachineOperationSchema,
  type AddSshProjectRequest,
  type CreateSshMachineRequest,
  type SshCommandRequest,
  type SshClientConfigInput,
  type SshMachineServiceAction,
  type SshMachineServiceLogsRequest,
  type SshMachineServiceStartResult,
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
const SERVICE_PROGRESS_INTERVAL_MS = 750;

/**
 * AppKit plugin for Databricks Sandbox lifecycle, SSH, service, and route operations.
 *
 * The plugin registers owner-scoped REST routes, AppKit agent tools, HTTP proxy
 * middleware, and WebSocket upgrade handling. It initializes
 * {@link SshRuntime} with the existing service-principal Lakebase pool captured
 * during setup and starts the expiration reaper.
 */
export class AppKitSshPlugin extends ToolRegistryPlugin<SshPluginConfig> {
  static manifest = {
    name: SSH_PLUGIN_NAME,
    displayName: "Sandboxes",
    description:
      "Creates and manages Databricks Sandboxes over REST and SSH, with remote web routing and Mastra tools.",
    stability: "beta",
    resources: { required: [], optional: [] },
    config: { schema: SSH_CONFIG_SCHEMA },
  } satisfies PluginManifest<typeof SSH_PLUGIN_NAME>;

  readonly runtime: SshRuntime;
  private mounted = false;
  private httpServer?: HttpServer;
  private upgradeAttachTimer?: ReturnType<typeof setTimeout>;
  private upgradeIdentityGate?: UpgradeIdentityGate;
  private readonly upgradeHandler = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    void this.handleUpgrade(request, socket, head);
  };

  /** Creates a plugin with a supplied shared runtime or a runtime from resolved config. */
  constructor(config: SshPluginConfig = {}) {
    super(config);
    this.runtime = config.runtime ?? new SshRuntime(resolveSshPluginConfig(config));
  }

  protected get toolRegistry(): ToolRegistry {
    return this.createToolRegistry();
  }

  override async setup(): Promise<void> {
    this.context?.onLifecycle("setup:complete", async () => {
      const pool = pluginRegistry
        .require(this.context, lakebase, AppKitSshPlugin.manifest)
        .exports().pool;
      await this.runtime.initializeOwnership(lakebaseResolver.captureServicePrincipalPool(pool));
      await this.runtime.startReaper(createWorkspaceClient());
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
      path: SSH_ROUTES.machines,
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
      path: SSH_ROUTES.machines,
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = createSshMachineOperationSchema.parse(req.body ?? {});
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
      path: SSH_ROUTES.machineStart,
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = startSshMachineOperationSchema.parse({ machineId: req.params.machineId });
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
      path: SSH_ROUTES.machineStop,
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = stopSshMachineOperationSchema.parse({ machineId: req.params.machineId });
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
      path: SSH_ROUTES.machine,
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = deleteSshMachineOperationSchema.parse({ machineId: req.params.machineId });
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
      name: "machineServiceLogs",
      method: "get",
      path: SSH_ROUTES.machineServiceLogs,
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = sshMachineServiceLogsRequestSchema.parse({
          machineId: req.params.machineId,
          service: req.params.service,
          maxLines: req.query.maxLines,
          maxChars: req.query.maxChars,
        });
        res.json(
          await this.withRequestAuth(
            req,
            "machineServiceLogs",
            (plugin) => plugin.machineServiceLogs(userId, input),
            () => this.runtime.readServiceLog(createWorkspaceClient(), userId, input),
          ),
        );
      },
    });
    this.route(router, {
      name: "startMachineService",
      method: "post",
      path: SSH_ROUTES.machineServiceStart,
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = startSshMachineServiceOperationSchema.parse({
          machineId: req.params.machineId,
          service: req.params.service,
        });
        const observation = await this.withRequestAuth(
          req,
          "startMachineService",
          (plugin) => plugin.startMachineService(userId, input),
          () => this.runtime.observeService(createWorkspaceClient(), userId, input),
        );
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream; charset=utf-8");
        res.setHeader("cache-control", "no-cache, no-transform");
        res.setHeader("connection", "keep-alive");
        res.setHeader("x-accel-buffering", "no");
        res.flushHeaders?.();
        for await (const snapshot of observation) {
          res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      },
    });
    this.route(router, {
      name: "executeCommand",
      method: "post",
      path: SSH_ROUTES.machineCommands,
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = executeSshCommandOperationSchema.parse({
          ...req.body,
          machineId: req.params.machineId,
        });
        res.json(
          await this.withRequestAuth(
            req,
            "executeCommand",
            (plugin) => plugin.executeCommand(userId, input),
            () => this.runtime.execute(createWorkspaceClient(), userId, input).result,
          ),
        );
      },
    });
    this.route(router, {
      name: "projects",
      method: "get",
      path: SSH_ROUTES.projects,
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        res.json(
          await this.withRequestAuth(
            req,
            "listProjects",
            (plugin) => plugin.listProjects(userId),
            async () => ({
              pathPrefix: this.runtime.projectPathPrefix(userId),
              projects: await this.runtime.projectList(createWorkspaceClient(), userId),
            }),
          ),
        );
      },
    });
    this.route(router, {
      name: "addProject",
      method: "post",
      path: SSH_ROUTES.projects,
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = addSshProjectOperationSchema.parse(req.body);
        res.json({
          project: await this.withRequestAuth(
            req,
            "addProject",
            (plugin) => plugin.addProject(userId, input),
            () => this.runtime.addProject(createWorkspaceClient(), userId, input),
          ),
        });
      },
    });
    this.route(router, {
      name: "removeProject",
      method: "delete",
      path: SSH_ROUTES.project,
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = removeSshProjectOperationSchema.parse({ projectId: req.params.projectId });
        res.json({
          removed: await this.withRequestAuth(
            req,
            "removeProject",
            (plugin) => plugin.removeProject(userId, input.projectId),
            () => this.runtime.removeProject(createWorkspaceClient(), userId, input.projectId),
          ),
        });
      },
    });
    this.route(router, {
      name: "openProjectTerminal",
      method: "post",
      path: SSH_ROUTES.projectTerminal,
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = sshProjectActionSchema.parse({ projectId: req.params.projectId });
        res.json(
          await this.withRequestAuth(
            req,
            "openProjectTerminal",
            (plugin) => plugin.openProjectTerminal(userId, input.projectId),
            () =>
              this.runtime.openProjectTerminal(createWorkspaceClient(), userId, input.projectId),
          ),
        );
      },
    });
    this.route(router, {
      name: "resetProject",
      method: "post",
      path: SSH_ROUTES.projectReset,
      handler: async (req, res) => {
        const userId = this.resolveUserId(req);
        const input = sshProjectActionSchema.parse({ projectId: req.params.projectId });
        res.json({
          project: await this.withRequestAuth(
            req,
            "resetProject",
            (plugin) => plugin.resetProject(userId, input.projectId),
            () => this.runtime.resetProject(createWorkspaceClient(), userId, input.projectId),
          ),
        });
      },
    });
  }

  /** Returns browser-safe route defaults published through AppKit client config. */
  clientConfig(): SshClientConfigInput {
    return { routePrefix: this.runtime.config.routePrefix };
  }

  /** Lists valid assigned machines through the plugin's active workspace identity. */
  async listMachines(userId: string) {
    return this.runtime.listMachines(this.workspaceClient(), userId);
  }

  /** Creates and assigns a managed Sandbox to one AppKit user. */
  async createMachine(userId: string, input: CreateSshMachineRequest = {}) {
    return this.runtime.createMachine(this.workspaceClient(), userId, input);
  }

  /** Starts one assigned Sandbox. */
  async startMachine(userId: string, machineId: string) {
    return this.runtime.startMachine(this.workspaceClient(), userId, machineId);
  }

  /** Stops one assigned Sandbox. */
  async stopMachine(userId: string, machineId: string) {
    return this.runtime.stopMachine(this.workspaceClient(), userId, machineId);
  }

  /** Deletes one assigned Sandbox. */
  async deleteMachine(userId: string, machineId: string) {
    return this.runtime.deleteMachine(this.workspaceClient(), userId, machineId);
  }

  /** Runs one command on an assigned Sandbox. */
  async executeCommand(userId: string, input: SshCommandRequest) {
    return this.runtime.execute(this.workspaceClient(), userId, input).result;
  }

  /** Observes one built-in terminal, desktop, or metrics service until it settles. */
  async startMachineService(userId: string, input: SshMachineServiceAction) {
    return this.runtime.observeService(this.workspaceClient(), userId, input);
  }

  /** Reads a bounded lifecycle-log tail for one built-in service. */
  async machineServiceLogs(userId: string, input: SshMachineServiceLogsRequest) {
    return this.runtime.readServiceLog(this.workspaceClient(), userId, input);
  }

  /** Creates or updates one isolated Sandbox project with a persisted route. */
  async addProject(userId: string, input: AddSshProjectRequest) {
    return this.runtime.addProject(this.workspaceClient(), userId, input);
  }

  /** Removes one Sandbox project and its isolated directory. */
  async removeProject(userId: string, projectId: string) {
    return this.runtime.removeProject(this.workspaceClient(), userId, projectId);
  }

  /** Lists persisted projects owned by one AppKit user. */
  async listProjects(userId: string) {
    return {
      pathPrefix: this.runtime.projectPathPrefix(userId),
      projects: await this.runtime.projectList(this.workspaceClient(), userId),
    };
  }

  /** Opens ttyd rooted at one persisted project. */
  async openProjectTerminal(userId: string, projectId: string) {
    return this.runtime.openProjectTerminal(this.workspaceClient(), userId, projectId);
  }

  /** Wipes and recreates one persisted project from its saved configuration. */
  async resetProject(userId: string, projectId: string) {
    return this.runtime.resetProject(this.workspaceClient(), userId, projectId);
  }

  /** Returns selected AppKit toolkit entries backed by this plugin's agent tools. */
  toolkit(options?: ToolkitOptions): Record<string, ToolkitEntry> {
    return toolkitEntries.entries(SSH_PLUGIN_NAME, this.getAgentTools(), options);
  }

  /** Executes one registered agent tool with the request resource and workspace identity. */
  override executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    context?: AgentToolExecutionContext,
  ): Promise<unknown> {
    return executeFromRegistry(
      this.createToolRegistry(context?.resourceId, this.executionWorkspaceClient(), context),
      name,
      args,
      signal,
    );
  }

  /**
   * Returns the typed sibling-plugin API for machine, command, service, route,
   * and toolkit operations.
   */
  exports() {
    return {
      listMachines: (userId: string) => this.listMachines(userId),
      createMachine: (userId: string, input: CreateSshMachineRequest) =>
        this.createMachine(userId, input),
      startMachine: (userId: string, machineId: string) => this.startMachine(userId, machineId),
      stopMachine: (userId: string, machineId: string) => this.stopMachine(userId, machineId),
      deleteMachine: (userId: string, machineId: string) => this.deleteMachine(userId, machineId),
      executeCommand: (userId: string, input: SshCommandRequest) =>
        this.executeCommand(userId, input),
      startMachineService: (userId: string, input: SshMachineServiceAction) =>
        this.startMachineService(userId, input),
      machineServiceLogs: (userId: string, input: SshMachineServiceLogsRequest) =>
        this.machineServiceLogs(userId, input),
      addProject: (userId: string, input: AddSshProjectRequest) => this.addProject(userId, input),
      listProjects: (userId: string) => this.listProjects(userId),
      openProjectTerminal: (userId: string, projectId: string) =>
        this.openProjectTerminal(userId, projectId),
      resetProject: (userId: string, projectId: string) => this.resetProject(userId, projectId),
      removeProject: (userId: string, projectId: string) => this.removeProject(userId, projectId),
      operations: (userId: string, userClient?: WorkspaceClient) =>
        this.operations(userId, userClient),
      toolkit: (options?: ToolkitOptions) => this.toolkit(options),
    };
  }

  /** Cancels reaper, restore, and command work before shutdown tears down resources. */
  override abortActiveOperations(): void {
    this.runtime.abortActiveOperations();
  }

  /** Detaches WebSocket handling and closes the shared runtime. */
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

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
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
    if (!(await this.runtime.routes.handleUpgrade(request, socket, head))) socket.destroy();
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

  /** Returns the Zod-owned operation contracts used by REST, plugins, and agent tools. */
  operations(userId?: string, userClient?: WorkspaceClient, context?: AgentToolExecutionContext) {
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
    return toolOperations.defineOperations({
      list_ssh_machines: {
        schema: listSshMachinesOperationSchema,
        execute: async (_input, signal) => {
          const response = await execute("listMachines", (client, resolvedUserId) =>
            this.runtime.listMachines(client, resolvedUserId, signal),
          );
          return {
            ...response,
            machines: response.machines.map((machine) => ({
              ...machine,
              services: machine.services.map(omitLifecycleLog),
              projects: machine.projects.map(omitLifecycleLog),
            })),
          };
        },
      },
      create_ssh_machine: {
        schema: createSshMachineOperationSchema,
        execute: (input, signal) =>
          execute("createMachine", (client, resolvedUserId) =>
            this.runtime.createMachine(client, resolvedUserId, input, signal),
          ),
      },
      start_ssh_machine: {
        schema: startSshMachineOperationSchema,
        execute: (input, signal) =>
          execute("startMachine", (client, resolvedUserId) =>
            this.runtime.startMachine(client, resolvedUserId, input.machineId, signal),
          ),
      },
      stop_ssh_machine: {
        schema: stopSshMachineOperationSchema,
        execute: (input, signal) =>
          execute("stopMachine", (client, resolvedUserId) =>
            this.runtime.stopMachine(client, resolvedUserId, input.machineId, signal),
          ),
      },
      delete_ssh_machine: {
        schema: deleteSshMachineOperationSchema,
        execute: (input, signal) =>
          execute("deleteMachine", (client, resolvedUserId) =>
            this.runtime.deleteMachine(client, resolvedUserId, input.machineId, signal),
          ),
      },
      execute_ssh_command: {
        schema: executeSshCommandOperationSchema,
        execute: (input, signal) =>
          execute(
            "executeCommand",
            (client, resolvedUserId) =>
              this.runtime.execute(client, resolvedUserId, input, signal).result,
          ),
      },
      start_ssh_machine_service: {
        schema: startSshMachineServiceOperationSchema,
        execute: async (input, signal) => {
          const observation = await execute("startMachineService", (client, resolvedUserId) =>
            this.runtime.observeService(client, resolvedUserId, input, signal),
          );
          return observeServiceForAgent(observation, input.service, context?.writeProgress);
        },
      },
      get_ssh_machine_service_logs: {
        schema: getSshMachineServiceLogsOperationSchema,
        execute: (input, signal) =>
          execute("machineServiceLogs", (client, resolvedUserId) =>
            this.runtime.readServiceLog(client, resolvedUserId, input, signal),
          ),
      },
      list_ssh_projects: {
        schema: listSshProjectsOperationSchema,
        execute: () =>
          execute("listProjects", async (client, resolvedUserId) => ({
            pathPrefix: this.runtime.projectPathPrefix(resolvedUserId),
            projects: (await this.runtime.projectList(client, resolvedUserId)).map(
              omitLifecycleLog,
            ),
          })),
      },
      add_ssh_project: {
        schema: addSshProjectOperationSchema,
        execute: async (input, signal) => ({
          project: await execute("addProject", (client, resolvedUserId) =>
            this.runtime.addProject(client, resolvedUserId, input, signal),
          ),
        }),
      },
      open_ssh_project_terminal: {
        schema: openSshProjectTerminalOperationSchema,
        execute: (input, signal) =>
          execute("openProjectTerminal", (client, resolvedUserId) =>
            this.runtime.openProjectTerminal(client, resolvedUserId, input.projectId, signal),
          ),
      },
      reset_ssh_project: {
        schema: resetSshProjectOperationSchema,
        execute: async (input, signal) => ({
          project: await execute("resetProject", (client, resolvedUserId) =>
            this.runtime.resetProject(client, resolvedUserId, input.projectId, signal),
          ),
        }),
      },
      remove_ssh_project: {
        schema: removeSshProjectOperationSchema,
        execute: async (input, signal) => ({
          removed: await execute("removeProject", (client, resolvedUserId) =>
            this.runtime.removeProject(client, resolvedUserId, input.projectId, signal),
          ),
        }),
      },
    });
  }

  private createToolRegistry(
    userId?: string,
    userClient?: WorkspaceClient,
    context?: AgentToolExecutionContext,
  ): ToolRegistry {
    return toolOperations.toolRegistryFromOperations(this.operations(userId, userClient, context));
  }

  private executionUserId(): string {
    const context = appkit.tryGetExecutionContext();
    if (!context) throw new Error("SSH tools require an AppKit execution context");
    return "userId" in context ? context.userId : context.serviceUserId;
  }
}

async function observeServiceForAgent(
  observation: AsyncIterable<{
    state: "stopped" | "starting" | "ready" | "error";
    log?: string;
  }>,
  kind: SshMachineServiceAction["service"],
  writeProgress?: AgentToolExecutionContext["writeProgress"],
): Promise<SshMachineServiceStartResult> {
  const label = SSH_MACHINE_SERVICES.find((service) => service.kind === kind)?.label ?? kind;
  let lastProgressAt = 0;
  let latestLog: string | undefined;
  let lastEmittedState: string | undefined;
  for await (const snapshot of observation) {
    if (snapshot.log !== undefined) latestLog = snapshot.log;
    const terminal = snapshot.state === "ready" || snapshot.state === "error";
    const now = Date.now();
    if (
      writeProgress &&
      (terminal ||
        lastEmittedState === undefined ||
        now - lastProgressAt >= SERVICE_PROGRESS_INTERVAL_MS)
    ) {
      await writeProgress(
        {
          type: "tool_status",
          status: snapshot.state,
          message:
            snapshot.state === "ready"
              ? `${label} ready`
              : snapshot.state === "error"
                ? `${label} failed`
                : `Installing ${label}`,
          ...(latestLog ? { detail: latestLog } : {}),
        },
        { transient: true },
      );
      lastProgressAt = now;
      lastEmittedState = snapshot.state;
    }
    if (snapshot.state === "ready") return { exitCode: 0 };
    if (snapshot.state === "error") return { exitCode: 1 };
  }
  return { exitCode: 1 };
}

/** Drops saved install logs from agent listings so tool results stay small. */
function omitLifecycleLog<T extends { log?: string }>({ log: _log, ...value }: T): Omit<T, "log"> {
  return value;
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

/**
 * AppKit plugin factory for {@link AppKitSshPlugin}.
 *
 * Register AppKit `lakebase()` before this plugin so setup can initialize
 * ownership storage and the expiration reaper.
 */
export const databricksSandbox = toPlugin(AppKitSshPlugin);
