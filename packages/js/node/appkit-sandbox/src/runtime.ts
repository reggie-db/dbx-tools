import { randomBytes } from "node:crypto";
import type { WorkspaceClient } from "@databricks/appkit";
import { exec } from "@dbx-tools/core";
import { asyncUtils, errorUtils, log, object } from "@dbx-tools/shared-core";
import {
  SSH_MACHINE_SERVICE_KINDS,
  addSshProjectRequestSchema,
  createSshMachineRequestSchema,
  sshCommandRequestSchema,
  sshMachineServiceActionSchema,
  sshMachineServiceLogsRequestSchema,
  type AddSshProjectRequest,
  type CreateSshMachineRequest,
  type DeleteSshMachineResponse,
  type SshCommandRequest,
  type SshMachine,
  type SshMachineService,
  type SshMachineServiceAction,
  type SshMachineServiceLogsRequest,
  type SshMachineServiceLogsResponse,
  type SshMachinesResponse,
  type SshProject,
  type SshProjectTerminalResponse,
} from "@dbx-tools/shared-databricks-sandbox";
import {
  generateProjectName,
  generateProjectPort,
  normalizeProjectName,
  normalizeProjectOpenPath,
  normalizeProjectPath,
  mergeProjectMiseConfig,
  packageScriptCommand,
  PROJECT_REMOVE_SCRIPT,
  PROJECT_SETUP_SCRIPT,
  projectDirectory,
  projectOpenUrl,
  renderProjectMiseConfig,
} from "./_projects.ts";
import {
  DESKTOP_PREREQUISITES_SCRIPT,
  privilegedSandboxExecution,
  SANDBOX_HOME,
  SANDBOX_USER_SETUP_SCRIPT,
} from "./_sandbox-user.ts";
import type { ResolvedSshPluginConfig } from "./config.ts";
import { desktopOpenUrl } from "./desktop.ts";
import { SshKeyStore } from "./key-store.ts";
import { createSandboxName, sandboxDisplayName } from "./managed-name.ts";
import {
  LakebaseMachineOwnershipStore,
  type MachineAssignment,
  type NewSandboxProjectRecord,
  type SandboxProjectRecord,
} from "./ownership.ts";
import { DatabricksSandboxClient, isSandboxUnavailable, type SandboxEntry } from "./rest.ts";
import { SshRouteRegistry } from "./routes.ts";
import {
  ensureSshService,
  inspectSshLifecycleStates,
  loadSshServiceDefinition,
  projectTerminalOpenUrl,
  readSshServiceOperationLog,
  sshServicePorts,
  stopSshService,
} from "./services.ts";
import { SshCommand, SshSession } from "./session.ts";

const POLL_INTERVAL_MS = 1_000;
const LIFECYCLE_TIMEOUT_MS = 180_000;
const logger = log.logger("appkit-sandbox:auth");
interface WorkspaceAuthAttempt<T> {
  user?: () => Promise<T>;
  servicePrincipal: () => Promise<T>;
}

interface WorkspaceAuthOperation {
  operation: string;
  transport: "agent-tool" | "code-mode" | "http";
  userId: string;
  tokenPresent?: boolean;
}

interface RuntimeEpoch {
  machine: number;
  owner: number;
}

/** Result of one Lakebase-to-Sandbox reconciliation pass. */
export interface SandboxReaperResult {
  /** Number of workspace Sandboxes examined. */
  scanned: number;
  /** Number of expired assigned Sandboxes deleted. */
  deleted: number;
  /** Number of orphaned Lakebase assignment rows removed. */
  removedAssignments: number;
  /** Number of cleanup operations that failed and were logged. */
  failures: number;
}

/**
 * Coordinates Sandbox REST operations, Lakebase assignments, SSH sessions,
 * command execution, built-in services, and web routes.
 *
 * Every machine operation verifies an unexpired Lakebase assignment for the
 * workspace, AppKit user, and Sandbox ID. Runtime epochs invalidate pending
 * session, service, and route work after stop, delete, or reconciliation.
 */
export class SshRuntime {
  readonly routes: SshRouteRegistry;
  private readonly keys: SshKeyStore;
  private readonly stopParentTerminationSignal: () => void;
  private readonly sessions = new Map<string, SshSession>();
  private readonly connecting = new Map<string, Promise<SshSession>>();
  private ownership?: LakebaseMachineOwnershipStore;
  private readonly services = new Map<string, SshMachineService>();
  private readonly projectStates = new Map<string, SshProject["state"]>();
  private readonly projectLogs = new Map<string, string>();
  private readonly startingServices = new Map<string, Promise<SshMachineService>>();
  private readonly machineTransitions = new Map<string, Promise<SandboxEntry>>();
  private readonly machineEpochs = new Map<string, number>();
  private readonly ownerEpochs = new Map<string, number>();
  private readonly machineSetup = new Map<string, Promise<void>>();
  private readonly shutdownController = new AbortController();
  private reaperTimer?: ReturnType<typeof setInterval>;
  private reaping?: Promise<SandboxReaperResult>;
  private closing?: Promise<void>;
  private closed = false;

  /** Creates a runtime with optional preinitialized ownership storage. */
  constructor(
    readonly config: ResolvedSshPluginConfig,
    ownership?: LakebaseMachineOwnershipStore,
  ) {
    this.keys = new SshKeyStore(config.keyDirectory);
    this.routes = new SshRouteRegistry(
      config.routePrefix,
      Math.min(2_147_000_000, config.connectTimeoutMs * 2 + 1_000),
    );
    this.stopParentTerminationSignal = exec.onParentTerminationSignal(() => {
      this.routes.beginShutdown();
    });
    this.ownership = ownership;
  }

  /**
   * Initializes the Lakebase ownership and expiration store.
   *
   * @throws When the AppKit Lakebase plugin did not provide a pool.
   */
  async initializeOwnership(
    pool?: Parameters<typeof LakebaseMachineOwnershipStore.create>[0],
  ): Promise<void> {
    if (!pool) {
      throw new Error("Databricks Sandbox management requires the AppKit Lakebase plugin");
    }
    const next = await LakebaseMachineOwnershipStore.create(pool);
    const previous = this.ownership;
    this.ownership = next;
    await previous?.close();
  }

  /**
   * Runs an immediate reconciliation pass and starts the periodic reaper when
   * {@link ResolvedSshPluginConfig.reaperIntervalSeconds} is greater than zero.
   * Initial failures are logged and returned as one failure instead of
   * preventing AppKit startup.
   */
  async startReaper(client: WorkspaceClient): Promise<SandboxReaperResult> {
    const signal = this.shutdownController.signal;
    if (this.config.reaperIntervalSeconds > 0 && !this.reaperTimer) {
      this.reaperTimer = setInterval(() => {
        void this.reapMachines(client, signal).catch((error) => {
          logger.warn("Sandbox reaper failed", authErrorMetadata(errorUtils.toError(error)));
        });
      }, this.config.reaperIntervalSeconds * 1_000);
      this.reaperTimer.unref?.();
    }
    try {
      const result = await this.reapMachines(client, signal);
      await this.restoreRunningProjects(client, signal);
      return result;
    } catch (error) {
      logger.warn(
        "Initial Sandbox reaper pass failed",
        authErrorMetadata(errorUtils.toError(error)),
      );
      return { scanned: 0, deleted: 0, removedAssignments: 0, failures: 1 };
    }
  }

  /**
   * Reconciles Lakebase assignments with managed Sandbox names and expirations.
   * Concurrent calls share one in-flight pass, and replicas serialize through
   * the workspace-scoped Lakebase advisory lock.
   */
  reapMachines(client: WorkspaceClient, signal?: AbortSignal): Promise<SandboxReaperResult> {
    if (this.reaping) return this.reaping;
    const operation = this.performReap(client, signal).finally(() => {
      if (this.reaping === operation) this.reaping = undefined;
    });
    this.reaping = operation;
    return operation;
  }

  /**
   * Runs a workspace operation with OBO credentials first and optionally retries
   * it with the app service principal.
   *
   * Service-principal retry occurs only when
   * {@link ResolvedSshPluginConfig.fallbackToServicePrincipal} is enabled.
   * Both attempts emit sanitized diagnostics.
   */
  async withAuthFallback<T>(
    operation: WorkspaceAuthOperation,
    attempt: WorkspaceAuthAttempt<T>,
  ): Promise<T> {
    if (attempt.user) {
      logger.debug("SSH workspace auth attempt", {
        ...operation,
        identity: "user-obo",
      });
      try {
        const result = await attempt.user();
        logger.debug("SSH workspace auth succeeded", {
          ...operation,
          identity: "user-obo",
        });
        return result;
      } catch (error) {
        logger.warn("SSH workspace OBO failed", {
          ...operation,
          identity: "user-obo",
          ...authErrorMetadata(errorUtils.toError(error)),
        });
        if (!this.config.fallbackToServicePrincipal) throw error;
      }
    }

    logger.info("SSH workspace auth fallback", {
      ...operation,
      identity: "app-service-principal",
    });
    try {
      const result = await attempt.servicePrincipal();
      logger.debug("SSH workspace auth succeeded", {
        ...operation,
        identity: "app-service-principal",
      });
      return result;
    } catch (error) {
      logger.warn("SSH workspace service-principal failed", {
        ...operation,
        identity: "app-service-principal",
        ...authErrorMetadata(errorUtils.toError(error)),
      });
      throw error;
    }
  }

  /**
   * Lists only valid, unexpired Sandboxes assigned to one AppKit user.
   * Returns `supported: false` when the workspace or region does not expose the
   * Sandbox API.
   */
  async listMachines(
    client: WorkspaceClient,
    userId: string,
    signal?: AbortSignal,
  ): Promise<SshMachinesResponse> {
    const api = new DatabricksSandboxClient(client);
    try {
      const [assignments, projects] = await Promise.all([
        this.ownershipStore().listAssignments(api.workspaceScope(), userId),
        this.ownershipStore().listProjects(api.workspaceScope(), { userId }),
      ]);
      const assigned = new Map(assignments.map((assignment) => [assignment.machineId, assignment]));
      const projectsByMachine = groupProjects(projects);
      const entries = await api.list(signal);
      await Promise.all(
        entries.map((entry) => {
          const assignment = assigned.get(entry.sandboxId);
          if (!assignment || !this.assignmentIsCurrent(assignment)) return Promise.resolve();
          return this.refreshRemoteLifecycleStates(
            client,
            api.workspaceScope(),
            userId,
            entry,
            projectsByMachine.get(entry.sandboxId) ?? [],
            signal,
          );
        }),
      );
      return {
        auto: this.config.auto,
        supported: true,
        machines: entries.flatMap((entry) => {
          const assignment = assigned.get(entry.sandboxId);
          return assignment && this.assignmentIsCurrent(assignment)
            ? [
                this.toMachine(
                  entry,
                  api.workspaceScope(),
                  userId,
                  assignment,
                  projectsByMachine.get(entry.sandboxId) ?? [],
                ),
              ]
            : [];
        }),
      };
    } catch (error) {
      if (isSandboxUnavailable(error)) {
        return { auto: this.config.auto, supported: false, machines: [] };
      }
      throw error;
    }
  }

  /**
   * Starts one assigned Sandbox, waits for the running state, and attempts to
   * provision its terminal and metrics services.
   */
  async startMachine(
    client: WorkspaceClient,
    userId: string,
    machineId: string,
    signal?: AbortSignal,
  ): Promise<SshMachine> {
    const api = new DatabricksSandboxClient(client);
    const owned = await this.requireOwnedMachine(api, userId, machineId, signal);
    const final = await this.convergeMachine(api, machineId, "running", owned.entry, signal);
    await Promise.allSettled(
      (["terminal", "stats"] as const).map((service) =>
        this.startService(client, userId, { machineId, service }, signal),
      ),
    );
    await this.assertAssigned(api.workspaceScope(), userId, machineId);
    await this.restoreMachineProjects(client, api, userId, final, signal);
    const projects = await this.ownershipStore().listProjects(api.workspaceScope(), {
      userId,
      machineId,
    });
    return this.toMachine(final, api.workspaceScope(), userId, owned.assignment, projects);
  }

  /**
   * Creates a managed Sandbox and persists its assignment before returning it.
   * If the Lakebase write fails, the newly created Sandbox is deleted.
   */
  async createMachine(
    client: WorkspaceClient,
    userId: string,
    input: CreateSshMachineRequest = {},
    signal?: AbortSignal,
  ): Promise<SshMachine> {
    const request = createSshMachineRequestSchema.parse(input);
    const api = new DatabricksSandboxClient(client);
    const expiresAtMs = Date.now() + this.config.sandboxLifetimeSeconds * 1_000;
    const managedName = createSandboxName();
    const expiresAt = new Date(expiresAtMs).toISOString();
    const created = await api.create(managedName, signal);
    const assignment = {
      workspaceScope: api.workspaceScope(),
      userId,
      machineId: created.sandboxId,
      managedName,
      expiresAt,
    };
    try {
      await this.ownershipStore().assign(assignment);
    } catch (error) {
      await api.delete(created.sandboxId, signal).catch(() => undefined);
      throw error;
    }
    const machine = this.toMachine(
      { ...created, name: managedName },
      api.workspaceScope(),
      userId,
      { ...assignment, createdAt: new Date().toISOString() },
      [],
    );
    if (!request.desktop) return machine;
    const started = await this.startMachine(client, userId, created.sandboxId, signal);
    const desktop = await this.startService(
      client,
      userId,
      { machineId: created.sandboxId, service: "desktop" },
      signal,
    );
    return {
      ...started,
      services: started.services.map((service) => (service.kind === "desktop" ? desktop : service)),
    };
  }

  /** Stops one assigned Sandbox, waits for it to stop, and clears local runtime state. */
  async stopMachine(
    client: WorkspaceClient,
    userId: string,
    machineId: string,
    signal?: AbortSignal,
  ): Promise<SshMachine> {
    const api = new DatabricksSandboxClient(client);
    const owned = await this.requireOwnedMachine(api, userId, machineId, signal);
    const final = await this.convergeMachine(
      api,
      machineId,
      "stopped",
      owned.entry,
      signal,
      () => this.clearMachineRuntime(api.workspaceScope(), machineId),
      (entry) =>
        normalizeStatus(entry.status) === "running"
          ? this.stopMachineServices(client, api, userId, entry, signal)
          : Promise.resolve(),
    );
    await this.assertAssigned(api.workspaceScope(), userId, machineId);
    const projects = await this.ownershipStore().listProjects(api.workspaceScope(), {
      userId,
      machineId,
    });
    return this.toMachine(final, api.workspaceScope(), userId, owned.assignment, projects);
  }

  /** Deletes one assigned Sandbox, its sole assignment, and local runtime state. */
  async deleteMachine(
    client: WorkspaceClient,
    userId: string,
    machineId: string,
    signal?: AbortSignal,
  ): Promise<DeleteSshMachineResponse> {
    const api = new DatabricksSandboxClient(client);
    await this.assertAssigned(api.workspaceScope(), userId, machineId);
    await this.clearMachineRuntime(api.workspaceScope(), machineId);
    await api.delete(machineId, signal);
    await Promise.all([
      this.ownershipStore().deleteProjectsForMachine(api.workspaceScope(), machineId),
      this.ownershipStore().deleteMachineServiceProjectsForMachine(api.workspaceScope(), machineId),
      this.ownershipStore().unassign(api.workspaceScope(), userId, machineId),
    ]);
    return { deleted: true };
  }

  /**
   * Starts or reuses one built-in browser service and its owner-scoped AppKit
   * route. Concurrent requests for the same service share one operation.
   */
  async startService(
    client: WorkspaceClient,
    userId: string,
    input: SshMachineServiceAction,
    signal?: AbortSignal,
  ): Promise<SshMachineService> {
    const request = sshMachineServiceActionSchema.parse(input);
    const api = new DatabricksSandboxClient(client);
    const workspaceScope = api.workspaceScope();
    await this.requireOwnedMachine(api, userId, request.machineId, signal);
    const key = serviceKey(workspaceScope, userId, request.machineId, request.service);
    const current = this.services.get(key);
    if (current?.state === "ready") return current;
    const pending = this.startingServices.get(key);
    if (pending) return current ?? this.startingService(request.machineId, request.service);
    const starting: SshMachineService = {
      kind: request.service,
      path: this.servicePath(request.machineId, request.service),
      openUrl: this.serviceOpenUrl(request.machineId, request.service),
      state: "starting",
    };
    this.services.set(key, starting);
    const operation = this.provisionService(client, userId, request, starting, signal).finally(
      () => {
        this.startingServices.delete(key);
      },
    );
    this.startingServices.set(key, operation);
    void operation.catch(() => undefined);
    return starting;
  }

  /**
   * Starts or reuses a built-in service and yields its observable lifecycle
   * snapshots until the current provisioning operation settles.
   */
  async observeService(
    client: WorkspaceClient,
    userId: string,
    input: SshMachineServiceAction,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<SshMachineService>> {
    const request = sshMachineServiceActionSchema.parse(input);
    const initial = await this.startService(client, userId, request, signal);
    const workspaceScope = new DatabricksSandboxClient(client).workspaceScope();
    const pending = this.startingServices.get(
      serviceKey(workspaceScope, userId, request.machineId, request.service),
    );
    let sessionPromise: Promise<SshSession> | undefined;
    const operationLog = async () => {
      sessionPromise ??= (async () => {
        const api = new DatabricksSandboxClient(client);
        const owned = await this.requireOwnedMachine(api, userId, request.machineId, signal);
        const machine = await this.convergeMachine(
          api,
          request.machineId,
          "running",
          owned.entry,
          signal,
        );
        const epoch = this.runtimeEpoch(workspaceScope, userId, request.machineId);
        return this.ensureSession(client, userId, machine, epoch, signal);
      })();
      return readSshServiceOperationLog(
        await sessionPromise,
        request.service,
        this.config.commandTimeoutMs,
        signal,
      );
    };
    return observeServiceStates(
      initial,
      pending,
      () =>
        this.services.get(serviceKey(workspaceScope, userId, request.machineId, request.service)),
      operationLog,
      signal,
    );
  }

  /** Reads a bounded lifecycle-log tail for one owned, running machine service. */
  async readServiceLog(
    client: WorkspaceClient,
    userId: string,
    input: SshMachineServiceLogsRequest,
    signal?: AbortSignal,
  ): Promise<SshMachineServiceLogsResponse> {
    const request = sshMachineServiceLogsRequestSchema.parse(input);
    const api = new DatabricksSandboxClient(client);
    const owned = await this.requireOwnedMachine(api, userId, request.machineId, signal);
    if (normalizeStatus(owned.entry.status) !== "running") return { log: "" };
    const epoch = this.runtimeEpoch(api.workspaceScope(), userId, request.machineId);
    const session = await this.ensureSession(client, userId, owned.entry, epoch, signal);
    return {
      log: await readSshServiceOperationLog(
        session,
        request.service,
        this.config.commandTimeoutMs,
        signal,
        request,
      ),
    };
  }

  private async ensureServiceReady(
    client: WorkspaceClient,
    userId: string,
    input: SshMachineServiceAction,
    signal?: AbortSignal,
  ): Promise<SshMachineService> {
    const request = sshMachineServiceActionSchema.parse(input);
    const api = new DatabricksSandboxClient(client);
    const workspaceScope = api.workspaceScope();
    await this.requireOwnedMachine(api, userId, request.machineId, signal);
    const key = serviceKey(workspaceScope, userId, request.machineId, request.service);
    const current = this.services.get(key);
    if (current?.state === "ready") return current;
    const pending = this.startingServices.get(key);
    if (pending) return pending;
    const starting = this.startingService(request.machineId, request.service);
    this.services.set(key, starting);
    const operation = this.provisionService(client, userId, request, starting, signal).finally(
      () => {
        this.startingServices.delete(key);
      },
    );
    this.startingServices.set(key, operation);
    return operation;
  }

  /**
   * Executes a command on an assigned Sandbox, starting the machine first when
   * `auto` is enabled and rejecting stale work after ownership changes.
   */
  execute(
    client: WorkspaceClient,
    userId: string,
    input: SshCommandRequest,
    signal?: AbortSignal,
  ): SshCommand {
    const request = sshCommandRequestSchema.parse(input);
    const timeoutMs = request.timeoutMs ?? this.config.commandTimeoutMs;
    return new SshCommand(
      request.command,
      request.args,
      { timeoutMs, signal },
      async (execution) => {
        const api = new DatabricksSandboxClient(client);
        const workspaceScope = api.workspaceScope();
        await this.assertAssigned(workspaceScope, userId, request.machineId);
        const machine = await this.ensureRunning(api, userId, request.machineId, execution.signal);
        const epoch = this.runtimeEpoch(workspaceScope, userId, request.machineId);
        const session = await this.ensureSession(client, userId, machine, epoch, execution.signal);
        await this.ensureMachineSoftware(
          workspaceScope,
          request.machineId,
          session,
          execution.signal,
        );
        await this.restoreMachineProjects(client, api, userId, machine, execution.signal);
        await this.assertAssigned(workspaceScope, userId, request.machineId);
        this.assertRuntimeEpoch(workspaceScope, userId, request.machineId, epoch);
        const inner = session.execute(request.command, request.args, {
          ...(request.cwd ? { cwd: request.cwd } : {}),
          ...(request.env ? { env: request.env } : {}),
          timeoutMs,
          signal: execution.signal,
        });
        return execution.follow(inner);
      },
    );
  }

  /** Creates or updates one isolated, persisted Sandbox project and route. */
  async addProject(
    client: WorkspaceClient,
    userId: string,
    input: AddSshProjectRequest,
    signal?: AbortSignal,
  ): Promise<SshProject> {
    const request = addSshProjectRequestSchema.parse(input);
    const api = new DatabricksSandboxClient(client);
    const workspaceScope = api.workspaceScope();
    await this.assertAssigned(workspaceScope, userId, request.machineId);
    const ownership = this.ownershipStore();
    const [machineProjects, serviceProjects] = await Promise.all([
      ownership.listProjects(workspaceScope, { machineId: request.machineId }),
      ownership.listMachineServiceProjects(workspaceScope, request.machineId),
    ]);
    const requestedName = request.name ? normalizeProjectName(request.name) : undefined;
    const existing = request.projectId
      ? await ownership.getProject(workspaceScope, userId, request.projectId)
      : requestedName
        ? await ownership.getProjectByName(workspaceScope, userId, request.machineId, requestedName)
        : undefined;
    if (request.projectId && !existing) {
      throw new Error(`Sandbox project ${request.projectId} was not found`);
    }
    if (existing && existing.machineId !== request.machineId) {
      throw new Error(`Sandbox project ${existing.projectId} belongs to another machine`);
    }
    const otherProjects = machineProjects.filter(
      (project) => project.projectId !== existing?.projectId,
    );
    const usedNames = new Set(otherProjects.map((project) => project.name));
    const name = requestedName ?? existing?.name ?? generateProjectName(usedNames);
    if (usedNames.has(name)) {
      throw new Error(`Sandbox project name ${name} is already in use on this machine`);
    }
    const projectPath =
      request.path !== undefined
        ? normalizeProjectPath(request.path)
        : (existing?.projectPath ?? normalizeProjectPath(name));
    if (otherProjects.some((project) => project.projectPath === projectPath)) {
      throw new Error(`Sandbox project path ${projectPath} is already in use on this machine`);
    }
    const port =
      request.port ??
      existing?.port ??
      generateProjectPort(
        new Set([
          ...otherProjects.map((project) => project.port),
          ...serviceProjects.map((project) => project.port),
          ...Object.values(sshServicePorts),
        ]),
      );
    if (
      otherProjects.some((project) => project.port === port) ||
      serviceProjects.some((project) => project.port === port) ||
      Object.values(sshServicePorts).some((reservedPort) => reservedPort === port)
    ) {
      throw new Error(`Sandbox project port ${port} is already in use on this machine`);
    }
    const openPath =
      request.openPath !== undefined
        ? normalizeProjectOpenPath(request.openPath)
        : existing?.openPath;
    const stripPrefix = request.stripPrefix ?? existing?.stripPrefix ?? true;
    const config = mergeProjectMiseConfig(request.config ?? existing?.config, request);
    const routeEnabled = input.route ?? existing?.route ?? true;
    const serviceDependencies = input.serviceDependencies ?? existing?.serviceDependencies ?? [];
    await Promise.all(
      serviceDependencies.map((service) =>
        this.ensureServiceReady(client, userId, { machineId: request.machineId, service }, signal),
      ),
    );
    const path = `${this.routes.userPathPrefix(userId)}/${projectPath}`;
    const miseToml = renderProjectMiseConfig(config, { name, path, port });
    const machine = await this.ensureRunning(api, userId, request.machineId, signal, true);
    const epoch = this.runtimeEpoch(workspaceScope, userId, request.machineId);
    const session = await this.ensureSession(client, userId, machine, epoch, signal);
    await this.ensureMachineSoftware(workspaceScope, request.machineId, session, signal);
    await this.restoreMachineProjects(client, api, userId, machine, signal);
    const directory = await this.prepareProjectDirectory(
      session,
      projectPath,
      miseToml,
      existing?.projectPath,
      signal,
    );
    await this.assertAssigned(workspaceScope, userId, request.machineId);
    this.assertRuntimeEpoch(workspaceScope, userId, request.machineId, epoch);
    const projectId = existing?.projectId ?? randomBytes(16).toString("hex");
    const routeChanged = Boolean(
      existing &&
      (existing.path !== path ||
        existing.port !== port ||
        existing.stripPrefix !== stripPrefix ||
        existing.route !== routeEnabled),
    );
    if (routeChanged) await this.routes.remove(projectId, userId);
    const record: NewSandboxProjectRecord = {
      workspaceScope,
      userId,
      projectId,
      name,
      machineId: request.machineId,
      directory,
      projectPath,
      path,
      ...(openPath ? { openPath } : {}),
      port,
      config,
      route: routeEnabled,
      serviceDependencies,
      stripPrefix,
    };
    try {
      if (routeEnabled) {
        const route = await this.routes.add(session, {
          id: projectId,
          ...(await this.userRouteAuthorization(workspaceScope, userId, request.machineId)),
          machineId: request.machineId,
          remoteHost: "127.0.0.1",
          remotePort: port,
          path: projectPath,
          stripPrefix,
        });
        record.path = route.path;
        record.stripPrefix = route.stripPrefix;
      } else {
        await this.routes.remove(projectId, userId);
      }
      await this.assertAssigned(workspaceScope, userId, request.machineId);
      this.assertRuntimeEpoch(workspaceScope, userId, request.machineId, epoch);
      await ownership.upsertProject(record);
      if (existing && existing.projectPath !== projectPath) {
        try {
          await this.removeProjectDirectory(session, existing.projectPath, signal);
        } catch (error) {
          logger.warn("Sandbox previous project directory cleanup failed", {
            userId,
            machineId: request.machineId,
            projectId,
            error: errorUtils.toError(error),
          });
        }
      }
      return this.toProject(
        {
          ...record,
          route: routeEnabled,
          serviceDependencies,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        routeEnabled,
      );
    } catch (error) {
      await this.routes.remove(projectId, userId);
      if (existing) await this.restoreProjectRoute(session, existing);
      throw error;
    }
  }

  /** Removes one project, runs optional mise uninstall, then deletes its directory and route. */
  async removeProject(
    client: WorkspaceClient,
    userId: string,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const api = new DatabricksSandboxClient(client);
    const workspaceScope = api.workspaceScope();
    const project = await this.ownershipStore().getProject(workspaceScope, userId, projectId);
    if (!project) return false;
    const owned = await this.requireOwnedMachine(api, userId, project.machineId, signal);
    const wasRunning = normalizeStatus(owned.entry.status) === "running";
    const machine = await this.convergeMachine(
      api,
      project.machineId,
      "running",
      owned.entry,
      signal,
    );
    try {
      const epoch = this.runtimeEpoch(workspaceScope, userId, project.machineId);
      const session = await this.ensureSession(client, userId, machine, epoch, signal);
      await this.removeProjectDirectory(session, project.projectPath, signal);
    } finally {
      if (!wasRunning) {
        await this.convergeMachine(
          api,
          project.machineId,
          "stopped",
          await api.get(project.machineId),
          signal,
          () => this.clearMachineRuntime(workspaceScope, project.machineId),
        );
      }
    }
    await this.routes.remove(projectId, userId);
    return this.ownershipStore().deleteProject(workspaceScope, userId, projectId);
  }

  /** Recreates one persisted project's directory from its saved mise configuration. */
  async resetProject(
    client: WorkspaceClient,
    userId: string,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<SshProject> {
    const api = new DatabricksSandboxClient(client);
    const workspaceScope = api.workspaceScope();
    const project = await this.ownershipStore().getProject(workspaceScope, userId, projectId);
    if (!project) throw new Error(`Sandbox project ${projectId} was not found`);
    const owned = await this.requireOwnedMachine(api, userId, project.machineId, signal);
    const wasRunning = normalizeStatus(owned.entry.status) === "running";
    const machine = await this.convergeMachine(
      api,
      project.machineId,
      "running",
      owned.entry,
      signal,
    );
    let reset: SshProject | undefined;
    try {
      const epoch = this.runtimeEpoch(workspaceScope, userId, project.machineId);
      const session = await this.ensureSession(client, userId, machine, epoch, signal);
      await this.ensureMachineSoftware(workspaceScope, project.machineId, session, signal);
      await this.removeProjectDirectory(session, project.projectPath, signal);
      const miseToml = renderProjectMiseConfig(project.config, {
        name: project.name,
        path: project.path,
        port: project.port,
      });
      const directory = await this.prepareProjectDirectory(
        session,
        project.projectPath,
        miseToml,
        undefined,
        signal,
      );
      const updated = { ...project, directory };
      await this.restoreProjectRoute(session, updated);
      reset = this.toProject(updated, project.route && wasRunning);
    } finally {
      if (!wasRunning) {
        await this.convergeMachine(
          api,
          project.machineId,
          "stopped",
          await api.get(project.machineId),
          signal,
          () => this.clearMachineRuntime(workspaceScope, project.machineId),
        );
      }
    }
    if (!reset) throw new Error(`Sandbox project ${projectId} reset did not complete`);
    return reset;
  }

  /** Opens ttyd rooted at one persisted project directory. */
  async openProjectTerminal(
    client: WorkspaceClient,
    userId: string,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<SshProjectTerminalResponse> {
    const api = new DatabricksSandboxClient(client);
    const workspaceScope = api.workspaceScope();
    const project = await this.ownershipStore().getProject(workspaceScope, userId, projectId);
    if (!project) throw new Error(`Sandbox project ${projectId} was not found`);
    const terminal = await this.startService(
      client,
      userId,
      { machineId: project.machineId, service: "terminal" },
      signal,
    );
    return {
      project: this.toProject(project, this.projectRouteReady(project)),
      service: {
        ...terminal,
        openUrl: projectTerminalOpenUrl(terminal.openUrl, project.directory),
      },
    };
  }

  /** Lists persisted projects for one AppKit user. */
  async projectList(client: WorkspaceClient, userId: string): Promise<SshProject[]> {
    const api = new DatabricksSandboxClient(client);
    const projects = await this.ownershipStore().listProjects(api.workspaceScope(), { userId });
    return projects.map((project) => this.toProject(project, this.projectRouteReady(project)));
  }

  /** Returns the user-scoped project path prefix beneath the configured root path. */
  projectPathPrefix(userId: string): string {
    return this.routes.userPathPrefix(userId);
  }

  /** Invalidates and closes one cached SSH session without changing the remote Sandbox. */
  async disconnect(workspaceScope: string, userId: string, machineId: string): Promise<void> {
    const key = sessionKey(workspaceScope, userId, machineId);
    this.bumpEpoch(this.ownerEpochs, key);
    const session = this.sessions.get(key);
    const pending = this.connecting.get(key);
    this.sessions.delete(key);
    this.connecting.delete(key);
    await this.routes.removeMachine(machineId, userId);
    const results = await Promise.allSettled([
      ...(session ? [session.close()] : []),
      ...(pending ? [pending] : []),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn("failed to close disconnected SSH session", {
          error: errorUtils.toError(result.reason),
        });
      }
    }
  }

  /** Stops the reaper and closes sessions, routes, service state, and ownership resources. */
  close(): Promise<void> {
    this.closed = true;
    this.abortActiveOperations();
    this.routes.beginShutdown();
    this.closing ??= this.closeResources();
    return this.closing;
  }

  private async closeResources(): Promise<void> {
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.reaperTimer = undefined;
    const pendingOperations: Promise<unknown>[] = [
      ...this.connecting.values(),
      ...this.startingServices.values(),
      ...this.machineSetup.values(),
      ...this.machineTransitions.values(),
    ];
    if (this.reaping) pendingOperations.push(this.reaping);
    pendingOperations.forEach((operation) => void operation.catch(() => undefined));
    this.connecting.clear();
    this.startingServices.clear();
    this.machineSetup.clear();
    this.machineTransitions.clear();
    try {
      await this.routes.close();
      const sessionClosures = [...this.sessions.values()].map((session) => session.close());
      void Promise.allSettled(sessionClosures);
      this.sessions.clear();
      this.services.clear();
      this.projectStates.clear();
      this.projectLogs.clear();
      this.machineEpochs.clear();
      this.ownerEpochs.clear();
      await this.ownership?.close();
    } finally {
      this.stopParentTerminationSignal();
    }
  }

  /** Aborts request, reaper, restore, and command work before resource teardown. */
  abortActiveOperations(): void {
    if (!this.shutdownController.signal.aborted) this.shutdownController.abort();
  }

  private async assertAssigned(
    workspaceScope: string,
    userId: string,
    machineId: string,
  ): Promise<void> {
    const assignment = await this.ownershipStore().get(workspaceScope, userId, machineId);
    if (assignment?.expiresAt && Date.parse(assignment.expiresAt) > Date.now()) return;
    throw new Error(`SSH machine ${machineId} is not assigned to the current user`);
  }

  private ownershipStore(): LakebaseMachineOwnershipStore {
    if (!this.ownership) {
      throw new Error("Databricks Sandbox ownership is not initialized in Lakebase");
    }
    return this.ownership;
  }

  private async requireOwnedMachine(
    api: DatabricksSandboxClient,
    userId: string,
    machineId: string,
    signal?: AbortSignal,
  ): Promise<{
    entry: SandboxEntry;
    assignment: MachineAssignment;
  }> {
    const assignment = await this.ownershipStore().get(api.workspaceScope(), userId, machineId);
    const entry = assignment ? await api.get(machineId, signal) : undefined;
    if (!entry || !assignment || !this.assignmentIsCurrent(assignment)) {
      throw new Error(
        `SSH machine ${machineId} is not assigned to the current user or has expired`,
      );
    }
    return { entry, assignment };
  }

  /** Returns whether Lakebase records an unexpired assignment for this machine. */
  private assignmentIsCurrent(assignment: MachineAssignment, now = Date.now()): boolean {
    return Boolean(assignment.expiresAt && Date.parse(assignment.expiresAt) > now);
  }

  private async performReap(
    client: WorkspaceClient,
    signal?: AbortSignal,
  ): Promise<SandboxReaperResult> {
    const api = new DatabricksSandboxClient(client);
    const workspaceScope = api.workspaceScope();
    const ownership = this.ownershipStore();
    return ownership.withReaperLock(workspaceScope, async () =>
      this.performLockedReap(api, ownership, workspaceScope, signal),
    );
  }

  private async performLockedReap(
    api: DatabricksSandboxClient,
    ownership: LakebaseMachineOwnershipStore,
    workspaceScope: string,
    signal?: AbortSignal,
  ): Promise<SandboxReaperResult> {
    const [entries, assignments] = await Promise.all([
      api.list(signal),
      ownership.listAssignments(workspaceScope),
    ]);
    const assignmentsByMachine = new Map(
      assignments.map((assignment) => [assignment.machineId, assignment]),
    );

    let deleted = 0;
    let removedAssignments = 0;
    let failures = 0;
    const existingMachineIds = new Set(entries.map((entry) => entry.sandboxId));
    const missingMachineIds = new Set(
      assignments
        .map((assignment) => assignment.machineId)
        .filter((machineId) => !existingMachineIds.has(machineId)),
    );
    for (const machineId of missingMachineIds) {
      try {
        await this.clearMachineRuntime(workspaceScope, machineId);
        await Promise.all([
          ownership.deleteProjectsForMachine(workspaceScope, machineId),
          ownership.deleteMachineServiceProjectsForMachine(workspaceScope, machineId),
          ownership
            .unassign(workspaceScope, assignmentsByMachine.get(machineId)!.userId, machineId)
            .then((removed) => {
              if (removed) removedAssignments += 1;
            }),
        ]);
        assignmentsByMachine.delete(machineId);
      } catch (error) {
        failures += 1;
        logger.warn("Sandbox reaper could not remove missing machine assignments", {
          machineId,
          ...authErrorMetadata(errorUtils.toError(error)),
        });
      }
    }

    const now = Date.now();
    for (const entry of entries) {
      const assignment = assignmentsByMachine.get(entry.sandboxId);
      if (!assignment || this.assignmentIsCurrent(assignment, now)) continue;

      try {
        await this.clearMachineRuntime(workspaceScope, entry.sandboxId);
        await api.delete(entry.sandboxId, signal);
        await Promise.all([
          ownership.deleteProjectsForMachine(workspaceScope, entry.sandboxId),
          ownership.deleteMachineServiceProjectsForMachine(workspaceScope, entry.sandboxId),
          ownership.unassign(workspaceScope, assignment.userId, entry.sandboxId).then((removed) => {
            if (removed) removedAssignments += 1;
          }),
        ]);
        deleted += 1;
        logger.info("Sandbox reaper deleted expired machine", {
          machineId: entry.sandboxId,
        });
      } catch (error) {
        failures += 1;
        logger.warn("Sandbox reaper could not delete expired machine", {
          machineId: entry.sandboxId,
          ...authErrorMetadata(errorUtils.toError(error)),
        });
      }
    }

    return { scanned: entries.length, deleted, removedAssignments, failures };
  }

  private async ensureRunning(
    api: DatabricksSandboxClient,
    userId: string,
    machineId: string,
    signal?: AbortSignal,
    explicit = false,
  ): Promise<SandboxEntry> {
    const current = (await this.requireOwnedMachine(api, userId, machineId, signal)).entry;
    if (normalizeStatus(current.status) === "running") return current;
    if (!this.config.auto && !explicit) {
      throw new Error(
        `SSH machine ${machineId} is ${current.status}; start it explicitly because auto is false`,
      );
    }
    return this.convergeMachine(api, machineId, "running", current, signal);
  }

  private async convergeMachine(
    api: DatabricksSandboxClient,
    machineId: string,
    expected: "running" | "stopped",
    current: SandboxEntry,
    signal?: AbortSignal,
    after?: () => Promise<void>,
    before?: (entry: SandboxEntry) => Promise<void>,
  ): Promise<SandboxEntry> {
    const key = machineRuntimeKey(api.workspaceScope(), machineId);
    const previous = this.machineTransitions.get(key);
    const operation = (async () => {
      let entry = current;
      if (previous) {
        await previous.catch(() => undefined);
        entry = await api.get(machineId, signal);
      }
      await before?.(entry);
      const entryAtExpected =
        expected === "running"
          ? ensureMachineStarted(api, machineId, entry, signal)
          : ensureMachineStopped(api, machineId, entry, signal);
      const result = await entryAtExpected;
      await after?.();
      return result;
    })();
    this.machineTransitions.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.machineTransitions.get(key) === operation) this.machineTransitions.delete(key);
    }
  }

  private async ensureSession(
    client: WorkspaceClient,
    userId: string,
    machine: SandboxEntry,
    epoch: RuntimeEpoch,
    signal?: AbortSignal,
  ): Promise<SshSession> {
    if (this.closed) throw new Error("SSH runtime is closed");
    const operationSignal = signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;
    const api = new DatabricksSandboxClient(client);
    const key = sessionKey(api.workspaceScope(), userId, machine.sandboxId);
    this.assertRuntimeEpoch(api.workspaceScope(), userId, machine.sandboxId, epoch);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const pending = this.connecting.get(key);
    if (pending) return pending;
    const connection = this.createSession(api, userId, machine, operationSignal);
    this.connecting.set(key, connection);
    let session: SshSession | undefined;
    try {
      session = await connection;
      if (this.connecting.get(key) !== connection) {
        await session.close();
        throw new Error(`SSH machine ${machine.sandboxId} session was revoked`);
      }
      await this.assertAssigned(api.workspaceScope(), userId, machine.sandboxId);
      this.assertRuntimeEpoch(api.workspaceScope(), userId, machine.sandboxId, epoch);
      this.sessions.set(key, session);
      return session;
    } catch (error) {
      await session?.close();
      throw error;
    } finally {
      if (this.connecting.get(key) === connection) this.connecting.delete(key);
    }
  }

  private async restoreRunningProjects(
    client: WorkspaceClient,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const api = new DatabricksSandboxClient(client);
    const workspaceScope = api.workspaceScope();
    const [entries, assignments, projects, serviceProjects] = await Promise.all([
      api.list(signal),
      this.ownershipStore().listAssignments(workspaceScope),
      this.ownershipStore().listProjects(workspaceScope),
      this.ownershipStore().listMachineServiceProjects(workspaceScope),
    ]);
    const entriesById = new Map(entries.map((entry) => [entry.sandboxId, entry]));
    const assignmentsByOwner = new Map(
      assignments.map((assignment) => [
        sessionKey(workspaceScope, assignment.userId, assignment.machineId),
        assignment,
      ]),
    );
    const owners = new Map<string, { userId: string; machine: SandboxEntry }>();
    for (const project of projects) {
      const machine = entriesById.get(project.machineId);
      const assignment = assignmentsByOwner.get(
        sessionKey(workspaceScope, project.userId, project.machineId),
      );
      if (
        !machine ||
        normalizeStatus(machine.status) !== "running" ||
        !assignment ||
        !this.assignmentIsCurrent(assignment)
      ) {
        continue;
      }
      owners.set(sessionKey(workspaceScope, project.userId, project.machineId), {
        userId: project.userId,
        machine,
      });
    }
    const projectRestores = [...owners.values()].map(({ userId, machine }) =>
      this.restoreMachineProjects(client, api, userId, machine, signal).catch((error) => {
        logger.warn("Sandbox project restoration failed", {
          userId,
          machineId: machine.sandboxId,
          ...authErrorMetadata(errorUtils.toError(error)),
        });
      }),
    );
    const now = Date.now();
    const serviceRestores = serviceProjects.flatMap((project) => {
      const machine = entriesById.get(project.machineId);
      const assignment = assignments.find(
        (candidate) =>
          candidate.machineId === project.machineId &&
          candidate.expiresAt &&
          Date.parse(candidate.expiresAt) > now,
      );
      if (!machine || normalizeStatus(machine.status) !== "running" || !assignment) return [];
      return [
        this.ensureServiceReady(
          client,
          assignment.userId,
          {
            machineId: project.machineId,
            service: project.serviceKind,
          },
          signal,
        ).catch((error) => {
          logger.warn("Sandbox machine service restoration failed", {
            userId: assignment.userId,
            machineId: project.machineId,
            service: project.serviceKind,
            ...authErrorMetadata(errorUtils.toError(error)),
          });
        }),
      ];
    });
    await Promise.all([...projectRestores, ...serviceRestores]);
  }

  private async restoreMachineProjects(
    client: WorkspaceClient,
    api: DatabricksSandboxClient,
    userId: string,
    machine: SandboxEntry,
    signal?: AbortSignal,
  ): Promise<void> {
    const workspaceScope = api.workspaceScope();
    const projects = await this.ownershipStore().listProjects(workspaceScope, {
      userId,
      machineId: machine.sandboxId,
    });
    if (projects.length === 0) return;
    const epoch = this.runtimeEpoch(workspaceScope, userId, machine.sandboxId);
    const session = await this.ensureSession(client, userId, machine, epoch, signal);
    await this.ensureMachineSoftware(workspaceScope, machine.sandboxId, session, signal);
    for (const project of projects) {
      try {
        const miseToml = renderProjectMiseConfig(project.config, {
          name: project.name,
          path: project.path,
          port: project.port,
        });
        await this.prepareProjectDirectory(
          session,
          project.projectPath,
          miseToml,
          undefined,
          signal,
        );
        await this.restoreProjectRoute(session, project);
      } catch (error) {
        logger.warn("Sandbox project route restoration failed", {
          userId: project.userId,
          machineId: project.machineId,
          projectId: project.projectId,
          ...authErrorMetadata(errorUtils.toError(error)),
        });
      }
    }
  }

  private ensureMachineSoftware(
    workspaceScope: string,
    machineId: string,
    session: SshSession,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = machineRuntimeKey(workspaceScope, machineId);
    const existing = this.machineSetup.get(key);
    if (existing) return existing;
    const operation = this.installMachineSoftware(session, signal).catch((error) => {
      this.machineSetup.delete(key);
      throw error;
    });
    this.machineSetup.set(key, operation);
    return operation;
  }

  private async installMachineSoftware(session: SshSession, signal?: AbortSignal): Promise<void> {
    for (const software of this.config.machineSoftware) {
      const result = await session.execute(
        "sh",
        [
          "-lc",
          `if ! (${software.checkCommand}); then\n${software.installCommand}\nfi\n${software.checkCommand}`,
        ],
        {
          cwd: SANDBOX_HOME,
          timeoutMs: Math.max(this.config.commandTimeoutMs, 600_000),
          signal,
        },
      ).result;
      if (!result.success) {
        throw new Error(
          `Sandbox software setup failed for ${software.name}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
        );
      }
    }
  }

  private async prepareProjectDirectory(
    session: SshSession,
    projectPath: string,
    miseToml: string,
    previousProjectPath: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await session.execute(
      "sh",
      [
        "-lc",
        packageScriptCommand(PROJECT_SETUP_SCRIPT, [
          projectPath,
          previousProjectPath ?? "",
          Buffer.from(miseToml).toString("base64"),
        ]),
      ],
      { timeoutMs: Math.max(this.config.commandTimeoutMs, 600_000), signal },
    ).result;
    if (!result.success) {
      throw new Error(
        `Sandbox project directory setup failed for ${projectPath}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
    const directoryLine = result.stdout
      .split("\n")
      .reverse()
      .find((line) => line.startsWith("__DBX_PROJECT_DIRECTORY__="));
    return (
      directoryLine?.slice("__DBX_PROJECT_DIRECTORY__=".length) || projectDirectory(projectPath)
    );
  }

  private async removeProjectDirectory(
    session: SshSession,
    projectPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await session.execute(
      "sh",
      ["-lc", packageScriptCommand(PROJECT_REMOVE_SCRIPT, [projectPath])],
      { timeoutMs: this.config.commandTimeoutMs, signal },
    ).result;
    if (!result.success) {
      throw new Error(
        `Sandbox project directory cleanup failed for ${projectPath}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
  }

  private async restoreProjectRoute(
    session: SshSession,
    project: SandboxProjectRecord,
  ): Promise<void> {
    if (!project.route) return;
    await this.routes.add(session, {
      id: project.projectId,
      ...(await this.userRouteAuthorization(
        project.workspaceScope,
        project.userId,
        project.machineId,
      )),
      machineId: project.machineId,
      remoteHost: "127.0.0.1",
      remotePort: project.port,
      path: project.path,
      stripPrefix: project.stripPrefix,
    });
  }

  private async userRouteAuthorization(
    workspaceScope: string,
    userId: string,
    machineId: string,
  ): Promise<{
    ownerId: string;
    ownerExpirations: Record<string, number>;
  }> {
    const ownership = this.ownershipStore();
    const assignment = await ownership.get(workspaceScope, userId, machineId);
    if (!assignment || !this.assignmentIsCurrent(assignment)) {
      throw new Error(`SSH machine ${machineId} is not assigned to the current user`);
    }
    return {
      ownerId: userId,
      ownerExpirations: { [userId]: Date.parse(assignment.expiresAt!) },
    };
  }

  private async stopMachineServices(
    client: WorkspaceClient,
    api: DatabricksSandboxClient,
    userId: string,
    machine: SandboxEntry,
    signal?: AbortSignal,
  ): Promise<void> {
    const workspaceScope = api.workspaceScope();
    const ownership = this.ownershipStore();
    const projects = await ownership.listMachineServiceProjects(workspaceScope, machine.sandboxId);
    if (projects.length === 0) return;
    const epoch = this.runtimeEpoch(workspaceScope, userId, machine.sandboxId);
    const session = await this.ensureSession(client, userId, machine, epoch, signal);
    const results = await Promise.allSettled(
      projects.map((project) =>
        ownership.withMachineServiceProjectLock(
          workspaceScope,
          machine.sandboxId,
          project.serviceKind,
          async () => {
            const definition = loadSshServiceDefinition(project.serviceKind, project.path);
            await stopSshService(
              session,
              definition,
              Math.max(this.config.commandTimeoutMs, 600_000),
              signal,
            );
          },
        ),
      ),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      logger.warn("Sandbox machine service stop failed", {
        userId,
        machineId: machine.sandboxId,
        service: projects[index]?.serviceKind,
        ...authErrorMetadata(errorUtils.toError(result.reason)),
      });
    });
  }

  private async provisionService(
    client: WorkspaceClient,
    userId: string,
    request: SshMachineServiceAction,
    starting: SshMachineService,
    signal?: AbortSignal,
  ): Promise<SshMachineService> {
    const api = new DatabricksSandboxClient(client);
    const workspaceScope = api.workspaceScope();
    const key = serviceKey(workspaceScope, userId, request.machineId, request.service);
    let epoch = this.runtimeEpoch(workspaceScope, userId, request.machineId);
    logger.info("SSH machine service provisioning started", {
      userId,
      machineId: request.machineId,
      service: request.service,
      path: starting.path,
    });
    try {
      await this.assertAssigned(workspaceScope, userId, request.machineId);
      const machine = await this.ensureRunning(api, userId, request.machineId, signal, true);
      epoch = this.runtimeEpoch(workspaceScope, userId, request.machineId);
      const session = await this.ensureSession(client, userId, machine, epoch, signal);
      await this.ensureMachineSoftware(workspaceScope, request.machineId, session, signal);
      const ownership = this.ownershipStore();
      const { target } = await ownership.withMachineServiceProjectLock(
        workspaceScope,
        request.machineId,
        request.service,
        async () => {
          await this.assertAssigned(workspaceScope, userId, request.machineId);
          this.assertRuntimeEpoch(workspaceScope, userId, request.machineId, epoch);
          const definition = loadSshServiceDefinition(request.service, starting.path);
          const persisted = await ownership.getMachineServiceProject(
            workspaceScope,
            request.machineId,
            request.service,
          );
          const serviceConfig = {
            miseToml: definition.miseToml,
            environment: { ...definition.environment },
          };
          const install =
            persisted?.definitionVersion !== definition.definitionVersion ||
            persisted.path !== starting.path ||
            JSON.stringify(persisted.config) !== JSON.stringify(serviceConfig);
          const conflictingProject = (
            await ownership.listProjects(workspaceScope, { machineId: request.machineId })
          ).find((project) => project.port === definition.target.remotePort);
          if (conflictingProject) {
            throw new Error(
              `Sandbox service ${request.service} requires port ${definition.target.remotePort}, which is reserved by project ${conflictingProject.name}`,
            );
          }
          if (request.service === "desktop") {
            const prerequisites = await session.executePrivileged(
              "sh",
              ["-lc", packageScriptCommand(DESKTOP_PREREQUISITES_SCRIPT, [])],
              {
                timeoutMs: Math.max(this.config.commandTimeoutMs, 600_000),
              },
              privilegedSandboxExecution,
            ).result;
            if (!prerequisites.success) {
              throw new Error(
                `Sandbox desktop prerequisites failed: ${
                  prerequisites.stderr.trim() || `exit ${prerequisites.exitCode}`
                }`,
              );
            }
          }
          const target = await ensureSshService(
            session,
            request.service,
            starting.path,
            Math.max(this.config.commandTimeoutMs, 600_000),
            signal,
            install,
          );
          await ownership.upsertMachineServiceProject({
            workspaceScope,
            machineId: request.machineId,
            serviceKind: request.service,
            definitionVersion: definition.definitionVersion,
            directory: definition.directory,
            path: starting.path,
            port: target.remotePort,
            config: serviceConfig,
            stripPrefix: target.stripPrefix,
          });
          const assignment = await ownership.getByMachine(workspaceScope, request.machineId);
          if (!assignment || !this.assignmentIsCurrent(assignment)) {
            throw new Error(`SSH machine ${request.machineId} has no active owner`);
          }
          return {
            route: await this.routes.add(session, {
              ownerId: assignment.userId,
              ownerExpirations: {
                [assignment.userId]: Date.parse(assignment.expiresAt!),
              },
              machineId: request.machineId,
              path: starting.path,
              internal: true,
              ...target,
            }),
            target,
          };
        },
      );
      try {
        await this.assertAssigned(workspaceScope, userId, request.machineId);
        this.assertRuntimeEpoch(workspaceScope, userId, request.machineId, epoch);
      } catch (error) {
        this.routes.revokeOwner(request.machineId, userId);
        throw error;
      }
      const ready: SshMachineService = { ...starting, openUrl: target.openUrl, state: "ready" };
      this.services.set(key, ready);
      logger.info("SSH machine service provisioning succeeded", {
        userId,
        machineId: request.machineId,
        service: request.service,
        path: ready.path,
        remoteHost: target.remoteHost,
        remotePort: target.remotePort,
      });
      return ready;
    } catch (error) {
      if (!this.runtimeEpochMatches(workspaceScope, userId, request.machineId, epoch)) {
        this.services.delete(key);
        throw error;
      }
      const message = errorUtils.errorMessage(error);
      const failed: SshMachineService = {
        ...starting,
        state: "error",
        error: message,
      };
      this.services.set(key, failed);
      logger.warn("SSH machine service provisioning failed", {
        userId,
        machineId: request.machineId,
        service: request.service,
        path: failed.path,
        ...authErrorMetadata(errorUtils.toError(error)),
      });
      throw new Error(message, { cause: error });
    }
  }

  private async createSession(
    api: DatabricksSandboxClient,
    userId: string,
    machine: SandboxEntry,
    signal?: AbortSignal,
  ): Promise<SshSession> {
    const key = await this.keys.ensureRegistered(api, userId, signal);
    const gatewayHost = machine.gatewayHost ?? key.gatewayHost;
    if (!gatewayHost) throw new Error("Databricks Sandbox did not return an SSH gateway host");
    const knownHost = await this.keys.knownHost(
      api.workspaceScope(),
      userId,
      gatewayHost,
      this.config.gatewayPort,
    );
    const session = new SshSession({
      host: gatewayHost,
      port: this.config.gatewayPort,
      username: machine.sandboxId,
      privateKey: key.privateKey,
      privateKeyPath: key.privateKeyPath,
      knownHostsPath: this.keys.knownHostsPath(
        api.workspaceScope(),
        userId,
        gatewayHost,
        this.config.gatewayPort,
      ),
      connectTimeoutMs: this.config.connectTimeoutMs,
      sshTransport: this.config.sshTransport,
      ssh2Patch: this.config.ssh2Patch,
      ...(knownHost ? { knownHost } : {}),
      rememberHost: (fingerprint, hostKey) =>
        this.keys.rememberHost(
          api.workspaceScope(),
          userId,
          gatewayHost,
          this.config.gatewayPort,
          fingerprint,
          hostKey,
        ),
    });
    try {
      await session.connect();
      const result = await session.executePrivileged(
        "sh",
        ["-lc", packageScriptCommand(SANDBOX_USER_SETUP_SCRIPT, [])],
        {
          timeoutMs: Math.max(this.config.commandTimeoutMs, 600_000),
        },
        privilegedSandboxExecution,
      ).result;
      if (!result.success) {
        throw new Error(
          `Sandbox user setup failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
        );
      }
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  private projectRouteReady(project: SandboxProjectRecord): boolean {
    if (!project.route) return true;
    return this.routes
      .list(project.machineId, project.userId)
      .some((route) => route.id === project.projectId);
  }

  private toProject(project: SandboxProjectRecord, ready: boolean): SshProject {
    const key = projectStateKey(project);
    const remoteState = this.projectStates.get(key);
    const log = this.projectLogs.get(key);
    return {
      id: project.projectId,
      name: project.name,
      machineId: project.machineId,
      directory: project.directory,
      path: project.path,
      ...(project.route ? { openUrl: projectOpenUrl(project.path, project.openPath) } : {}),
      port: project.port,
      stripPrefix: project.stripPrefix,
      state: remoteState ?? (!project.route || ready ? "ready" : "stopped"),
      ...(log !== undefined ? { log } : {}),
    };
  }

  private toMachine(
    entry: SandboxEntry,
    workspaceScope: string,
    userId: string,
    assignment: MachineAssignment,
    projects: SandboxProjectRecord[],
  ): SshMachine {
    const status = normalizeStatus(entry.status);
    return {
      id: entry.sandboxId,
      name: sandboxDisplayName(assignment.managedName ?? entry.name),
      provider: "databricks-sandbox",
      status,
      ...(entry.gatewayHost ? { gatewayHost: entry.gatewayHost } : {}),
      ...(entry.createTime ? { createdAt: entry.createTime } : {}),
      expiresAt: assignment.expiresAt!,
      ...(entry.lastStartTime ? { lastStartedAt: entry.lastStartTime } : {}),
      ...(idleTimeoutSeconds(entry.idleTimeout) !== undefined
        ? { autoStopSeconds: idleTimeoutSeconds(entry.idleTimeout) }
        : {}),
      projects: projects.map((project) => this.toProject(project, this.projectRouteReady(project))),
      services: SSH_MACHINE_SERVICE_KINDS.map(
        (kind): SshMachineService =>
          this.services.get(serviceKey(workspaceScope, userId, entry.sandboxId, kind)) ?? {
            kind,
            path: this.servicePath(entry.sandboxId, kind),
            openUrl: this.serviceOpenUrl(entry.sandboxId, kind),
            state: "stopped",
          },
      ),
      canStart: status === "stopped" || status === "unknown" || status === "error",
      canStop: status === "running" || status === "starting" || status === "stopping",
      canConnect: Boolean(entry.gatewayHost) && status === "running",
    };
  }

  private servicePath(machineId: string, kind: SshMachineService["kind"]): string {
    const service = kind === "terminal" ? "terminal" : kind === "desktop" ? "desktop" : "metrics";
    const routePrefix = this.config.routePrefix.replace(/\/+$/, "");
    return `${routePrefix}/${service}/${machinePathSegment(machineId)}`;
  }

  private startingService(machineId: string, kind: SshMachineService["kind"]): SshMachineService {
    return {
      kind,
      path: this.servicePath(machineId, kind),
      openUrl: this.serviceOpenUrl(machineId, kind),
      state: "starting",
    };
  }

  private serviceOpenUrl(machineId: string, kind: SshMachineService["kind"]): string {
    const path = this.servicePath(machineId, kind);
    if (kind !== "desktop") return `${path}/`;
    return desktopOpenUrl(path);
  }

  private runtimeEpoch(workspaceScope: string, userId: string, machineId: string): RuntimeEpoch {
    return {
      machine: this.machineEpochs.get(machineRuntimeKey(workspaceScope, machineId)) ?? 0,
      owner: this.ownerEpochs.get(sessionKey(workspaceScope, userId, machineId)) ?? 0,
    };
  }

  private runtimeEpochMatches(
    workspaceScope: string,
    userId: string,
    machineId: string,
    epoch: RuntimeEpoch,
  ): boolean {
    const current = this.runtimeEpoch(workspaceScope, userId, machineId);
    return current.machine === epoch.machine && current.owner === epoch.owner;
  }

  private assertRuntimeEpoch(
    workspaceScope: string,
    userId: string,
    machineId: string,
    epoch: RuntimeEpoch,
  ): void {
    if (this.runtimeEpochMatches(workspaceScope, userId, machineId, epoch)) return;
    throw new Error(`SSH machine ${machineId} operation was revoked`);
  }

  private async clearMachineRuntime(workspaceScope: string, machineId: string): Promise<void> {
    this.bumpEpoch(this.machineEpochs, machineRuntimeKey(workspaceScope, machineId));
    await this.routes.removeMachine(machineId);
    const pendingConnections: Promise<SshSession>[] = [];
    for (const [key, session] of this.sessions) {
      if (!sessionKeyMatchesMachine(key, workspaceScope, machineId)) continue;
      await session.close();
      this.sessions.delete(key);
    }
    for (const [key, pending] of this.connecting) {
      if (!sessionKeyMatchesMachine(key, workspaceScope, machineId)) continue;
      pendingConnections.push(pending);
      this.connecting.delete(key);
    }
    await Promise.allSettled(pendingConnections);
    for (const key of this.services.keys()) {
      if (serviceKeyMatchesMachine(key, workspaceScope, machineId)) this.services.delete(key);
    }
    for (const key of this.startingServices.keys()) {
      if (serviceKeyMatchesMachine(key, workspaceScope, machineId)) {
        this.startingServices.delete(key);
      }
    }
    for (const key of this.projectStates.keys()) {
      if (projectStateKeyMatchesMachine(key, workspaceScope, machineId)) {
        this.projectStates.delete(key);
      }
    }
    for (const key of this.projectLogs.keys()) {
      if (projectStateKeyMatchesMachine(key, workspaceScope, machineId)) {
        this.projectLogs.delete(key);
      }
    }
    this.machineSetup.delete(machineRuntimeKey(workspaceScope, machineId));
  }

  private async refreshRemoteLifecycleStates(
    client: WorkspaceClient,
    workspaceScope: string,
    userId: string,
    entry: SandboxEntry,
    projects: readonly SandboxProjectRecord[],
    signal?: AbortSignal,
  ): Promise<void> {
    const key = sessionKey(workspaceScope, userId, entry.sandboxId);
    if (normalizeStatus(entry.status) !== "running") {
      await this.routes.removeMachine(entry.sandboxId, userId);
      await this.sessions.get(key)?.close();
      this.sessions.delete(key);
      return;
    }
    try {
      const epoch = this.runtimeEpoch(workspaceScope, userId, entry.sandboxId);
      const session = await this.ensureSession(client, userId, entry, epoch, signal);
      const states = await inspectSshLifecycleStates(session, this.config.commandTimeoutMs, signal);
      for (const [kind, state] of states.services) {
        const key = serviceKey(workspaceScope, userId, entry.sandboxId, kind);
        const current = this.services.get(key);
        const path = current?.path ?? this.servicePath(entry.sandboxId, kind);
        this.services.set(key, {
          kind,
          path,
          openUrl: current?.openUrl ?? this.serviceOpenUrl(entry.sandboxId, kind),
          state,
          ...(states.serviceLogs.get(kind) ? { log: states.serviceLogs.get(kind) } : {}),
          ...(current?.error && state === "error" ? { error: current.error } : {}),
        });
        if (state !== "ready") {
          const route = this.routes
            .list(entry.sandboxId, userId, { includeInternal: true })
            .find((candidate) => candidate.path === path);
          if (route) await this.routes.remove(route.id);
        }
      }
      for (const project of projects) {
        const key = projectStateKey(project);
        const state = states.projects.get(project.projectPath);
        if (state) this.projectStates.set(key, state);
        const log = states.projectLogs.get(project.projectPath);
        if (log !== undefined) this.projectLogs.set(key, log);
      }
    } catch (error) {
      logger.debug("Sandbox lifecycle status inspection failed", {
        userId,
        machineId: entry.sandboxId,
        ...authErrorMetadata(errorUtils.toError(error)),
      });
    }
  }

  private bumpEpoch(epochs: Map<string, number>, key: string): void {
    epochs.set(key, (epochs.get(key) ?? 0) + 1);
  }
}

function groupProjects(projects: SandboxProjectRecord[]): Map<string, SandboxProjectRecord[]> {
  const grouped = new Map<string, SandboxProjectRecord[]>();
  for (const project of projects) {
    const current = grouped.get(project.machineId) ?? [];
    current.push(project);
    grouped.set(project.machineId, current);
  }
  return grouped;
}

async function* observeServiceStates(
  initial: SshMachineService,
  pending: Promise<SshMachineService> | undefined,
  current: () => SshMachineService | undefined,
  operationLog: () => Promise<string>,
  signal?: AbortSignal,
): AsyncIterable<SshMachineService> {
  yield initial;
  if (initial.state !== "starting" || !pending) return;
  let observedLog = "";
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    try {
      const log = await operationLog();
      if (log !== observedLog) {
        const snapshot = current() ?? initial;
        yield { ...snapshot, log };
      }
      observedLog = log;
    } catch {
      // Provisioning owns the final error; transient log reads may race remote setup.
    }
    if (!settled) await asyncUtils.sleep(250, signal);
  }
  try {
    const resolved = await pending;
    try {
      const log = await operationLog();
      if (log !== observedLog) {
        yield { ...resolved, log };
      }
    } catch {
      // The final lifecycle snapshot remains authoritative when the log is unavailable.
    }
    yield resolved;
  } catch {
    const failed = current();
    if (failed) yield failed;
  }
}

function serviceKey(
  workspaceScope: string,
  userId: string,
  machineId: string,
  kind: SshMachineService["kind"],
): string {
  return `${sessionKey(workspaceScope, userId, machineId)}\0${kind}`;
}

function machineRuntimeKey(workspaceScope: string, machineId: string): string {
  return `${workspaceScope}\0${machineId}`;
}

function sessionKeyMatchesMachine(key: string, workspaceScope: string, machineId: string): boolean {
  const [candidateWorkspace, , candidateMachine] = key.split("\0");
  return candidateWorkspace === workspaceScope && candidateMachine === machineId;
}

function serviceKeyMatchesMachine(key: string, workspaceScope: string, machineId: string): boolean {
  return sessionKeyMatchesMachine(key, workspaceScope, machineId);
}

function projectStateKey(project: SandboxProjectRecord): string {
  return `${sessionKey(project.workspaceScope, project.userId, project.machineId)}\0${project.projectPath}`;
}

function projectStateKeyMatchesMachine(
  key: string,
  workspaceScope: string,
  machineId: string,
): boolean {
  return sessionKeyMatchesMachine(key, workspaceScope, machineId);
}

function machinePathSegment(machineId: string): string {
  return (
    machineId
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-|-$/g, "") || "machine"
  );
}

async function waitForStatus(
  api: DatabricksSandboxClient,
  machineId: string,
  expected: "running" | "stopped",
  current: SandboxEntry,
  signal?: AbortSignal,
): Promise<SandboxEntry> {
  const deadline = Date.now() + LIFECYCLE_TIMEOUT_MS;
  let entry = current;
  while (normalizeStatus(entry.status) !== expected) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${machineId} to become ${expected}`);
    }
    entry = await api.get(machineId, signal);
    if (normalizeStatus(entry.status) !== expected) {
      await asyncUtils.sleep(POLL_INTERVAL_MS, signal);
    }
  }
  return entry;
}

async function ensureMachineStarted(
  api: DatabricksSandboxClient,
  machineId: string,
  current: SandboxEntry,
  signal?: AbortSignal,
): Promise<SandboxEntry> {
  let entry = current;
  const status = normalizeStatus(entry.status);
  if (status === "running") return entry;
  if (status === "starting") return waitForStatus(api, machineId, "running", entry, signal);
  if (status === "stopping") {
    entry = await waitForStatus(api, machineId, "stopped", entry, signal);
  }
  return waitForStatus(api, machineId, "running", await api.start(machineId, signal), signal);
}

async function ensureMachineStopped(
  api: DatabricksSandboxClient,
  machineId: string,
  current: SandboxEntry,
  signal?: AbortSignal,
): Promise<SandboxEntry> {
  let entry = current;
  const status = normalizeStatus(entry.status);
  if (status === "stopped") return entry;
  if (status === "stopping") return waitForStatus(api, machineId, "stopped", entry, signal);
  if (status === "starting") {
    entry = await waitForStatus(api, machineId, "running", entry, signal);
  }
  return waitForStatus(api, machineId, "stopped", await api.stop(machineId, signal), signal);
}

function normalizeStatus(value: string): SshMachine["status"] {
  switch (value.trim().toLowerCase()) {
    case "starting":
    case "provisioning":
      return "starting";
    case "running":
      return "running";
    case "stopping":
      return "stopping";
    case "stopped":
      return "stopped";
    case "failed":
    case "error":
      return "error";
    default:
      return "unknown";
  }
}

function idleTimeoutSeconds(value: string | undefined): number | undefined {
  if (!value?.endsWith("s")) return undefined;
  const seconds = Number(value.slice(0, -1));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function sessionKey(workspaceScope: string, userId: string, machineId: string): string {
  return `${workspaceScope}\0${userId}\0${machineId}`;
}

function authErrorMetadata(error: Error): Record<string, unknown> {
  const record: Record<string, unknown> = object.isRecord(error) ? error : {};
  const response: Record<string, unknown> = object.isRecord(record.response) ? record.response : {};
  const body = record.body ?? response.body ?? response.data;
  return {
    error,
    status: record.status ?? record.statusCode ?? response.status,
    statusText: response.statusText,
    errorCode: record.errorCode ?? record.error_code ?? bodyField(body, "error_code"),
    requestId: record.requestId ?? record.request_id ?? bodyField(body, "request_id"),
    responseBody: safeBody(body),
  };
}

function bodyField(value: unknown, key: string): unknown {
  return object.isRecord(value) ? value[key] : undefined;
}

function safeBody(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value, (key, entry) =>
      /authorization|cookie|secret|token|password|credential|headers|config|request/i.test(key)
        ? "[redacted]"
        : entry,
    );
    return serialized.length > 4_000 ? `${serialized.slice(0, 4_000)}…` : serialized;
  } catch {
    return String(value).slice(0, 4_000);
  }
}
