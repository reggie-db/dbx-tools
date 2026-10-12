import type { WorkspaceClient } from "@databricks/appkit";
import { asyncUtils, errorUtils, log, object } from "@dbx-tools/shared-core";
import {
  addSshRouteRequestSchema,
  createSshMachineRequestSchema,
  sshCommandRequestSchema,
  sshMachineServiceActionSchema,
  type AddSshRouteRequest,
  type CreateSshMachineRequest,
  type DeleteSshMachineResponse,
  type SshCommandRequest,
  type SshCommandResult,
  type SshMachine,
  type SshMachineService,
  type SshMachineServiceAction,
  type SshMachinesResponse,
  type SshRoute,
} from "@dbx-tools/shared-databricks-sandbox";
import type { ResolvedSshPluginConfig } from "./config.ts";
import { SshKeyStore } from "./key-store.ts";
import {
  createManagedSandboxName,
  isManagedSandboxNameCandidate,
  parseManagedSandboxName,
  sandboxUserId,
  type ManagedSandboxName,
} from "./managed-name.ts";
import { LakebaseMachineOwnershipStore, type MachineAssignment } from "./ownership.ts";
import { DatabricksSandboxClient, isSandboxUnavailable, type SandboxEntry } from "./rest.ts";
import { SshRouteRegistry } from "./routes.ts";
import { ensureSshService } from "./services.ts";
import { SshSession } from "./session.ts";

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
  /** Number of invalid or expired managed Sandboxes deleted. */
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
 * Every machine operation verifies an unexpired assignment for the workspace,
 * AppKit user, Sandbox ID, and managed name. Runtime epochs invalidate pending
 * session, service, and route work after stop, delete, or reconciliation.
 */
export class SshRuntime {
  readonly routes: SshRouteRegistry;
  private readonly keys: SshKeyStore;
  private readonly sessions = new Map<string, SshSession>();
  private readonly connecting = new Map<string, Promise<SshSession>>();
  private ownership?: LakebaseMachineOwnershipStore;
  private readonly services = new Map<string, SshMachineService>();
  private readonly startingServices = new Map<string, Promise<SshMachineService>>();
  private readonly machineEpochs = new Map<string, number>();
  private readonly ownerEpochs = new Map<string, number>();
  private reaperTimer?: ReturnType<typeof setInterval>;
  private reaping?: Promise<SandboxReaperResult>;

  /** Creates a runtime with optional preinitialized ownership storage. */
  constructor(
    readonly config: ResolvedSshPluginConfig,
    ownership?: LakebaseMachineOwnershipStore,
  ) {
    this.keys = new SshKeyStore(config.keyDirectory);
    this.routes = new SshRouteRegistry(config.routePrefix);
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
    if (this.config.reaperIntervalSeconds > 0 && !this.reaperTimer) {
      this.reaperTimer = setInterval(() => {
        void this.reapMachines(client).catch((error) => {
          logger.warn("Sandbox reaper failed", authErrorMetadata(errorUtils.toError(error)));
        });
      }, this.config.reaperIntervalSeconds * 1_000);
      this.reaperTimer.unref?.();
    }
    try {
      return await this.reapMachines(client);
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
      const assignments = await this.ownershipStore().listAssignments(api.workspaceScope(), userId);
      const assigned = new Map(assignments.map((assignment) => [assignment.machineId, assignment]));
      const entries = await api.list(signal);
      return {
        auto: this.config.auto,
        supported: true,
        machines: entries.flatMap((entry) => {
          const assignment = assigned.get(entry.sandboxId);
          const managed = assignment
            ? this.validateManagedMachine(entry, assignment, userId)
            : undefined;
          return assignment && managed
            ? [this.toMachine(entry, api.workspaceScope(), userId, assignment, managed)]
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
    const current = owned.entry;
    const updated =
      normalizeStatus(current.status) === "running" ? current : await api.start(machineId, signal);
    const final = await waitForStatus(api, machineId, "running", updated, signal);
    await Promise.allSettled(
      (["terminal", "stats"] as const).map((service) =>
        this.startService(client, userId, { machineId, service }, signal),
      ),
    );
    await this.assertAssigned(api.workspaceScope(), userId, machineId);
    return this.toMachine(final, api.workspaceScope(), userId, owned.assignment, owned.managed);
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
    createSshMachineRequestSchema.parse(input);
    const api = new DatabricksSandboxClient(client);
    const expiresAtMs = Date.now() + this.config.sandboxLifetimeSeconds * 1_000;
    const managedName = createManagedSandboxName(userId, expiresAtMs);
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
    const managed = parseManagedSandboxName(managedName)!;
    return this.toMachine(
      { ...created, name: managedName },
      api.workspaceScope(),
      userId,
      { ...assignment, createdAt: new Date().toISOString() },
      managed,
    );
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
    const current = owned.entry;
    const updated =
      normalizeStatus(current.status) === "stopped" ? current : await api.stop(machineId, signal);
    const final = await waitForStatus(api, machineId, "stopped", updated, signal);
    await this.clearMachineRuntime(api.workspaceScope(), machineId);
    await this.assertAssigned(api.workspaceScope(), userId, machineId);
    return this.toMachine(final, api.workspaceScope(), userId, owned.assignment, owned.managed);
  }

  /** Deletes one assigned Sandbox, removes all assignments, and clears local runtime state. */
  async deleteMachine(
    client: WorkspaceClient,
    userId: string,
    machineId: string,
    signal?: AbortSignal,
  ): Promise<DeleteSshMachineResponse> {
    const api = new DatabricksSandboxClient(client);
    await this.assertAssigned(api.workspaceScope(), userId, machineId);
    await api.delete(machineId, signal);
    await this.ownershipStore().unassignAll(api.workspaceScope(), machineId);
    await this.clearMachineRuntime(api.workspaceScope(), machineId);
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
    await this.assertAssigned(workspaceScope, userId, request.machineId);
    const epoch = this.runtimeEpoch(workspaceScope, userId, request.machineId);
    const key = serviceKey(workspaceScope, userId, request.machineId, request.service);
    const current = this.services.get(key);
    if (
      current?.state === "ready" &&
      this.routes
        .list(request.machineId, userId, { includeInternal: true })
        .some((route) => route.path === current.path)
    ) {
      return current;
    }
    const pending = this.startingServices.get(key);
    if (pending) return pending;
    const starting: SshMachineService = {
      kind: request.service,
      path: this.servicePath(request.machineId, request.service),
      state: "starting",
    };
    this.services.set(key, starting);
    const operation = this.provisionService(
      client,
      userId,
      request,
      starting,
      epoch,
      signal,
    ).finally(() => {
      this.startingServices.delete(key);
    });
    this.startingServices.set(key, operation);
    return operation;
  }

  /**
   * Executes a command on an assigned Sandbox, starting the machine first when
   * `auto` is enabled and rejecting stale work after ownership changes.
   */
  async execute(
    client: WorkspaceClient,
    userId: string,
    input: SshCommandRequest,
    signal?: AbortSignal,
  ): Promise<SshCommandResult> {
    const request = sshCommandRequestSchema.parse(input);
    const api = new DatabricksSandboxClient(client);
    await this.assertAssigned(api.workspaceScope(), userId, request.machineId);
    const epoch = this.runtimeEpoch(api.workspaceScope(), userId, request.machineId);
    const machine = await this.ensureRunning(api, userId, request.machineId, signal);
    const timeoutMs = request.timeoutMs ?? this.config.commandTimeoutMs;
    const session = await this.ensureSession(client, userId, machine, epoch, signal);
    await this.assertAssigned(api.workspaceScope(), userId, request.machineId);
    this.assertRuntimeEpoch(api.workspaceScope(), userId, request.machineId, epoch);
    return session.execute(request.command, request.args, {
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.env ? { env: request.env } : {}),
      timeoutMs,
      signal,
    });
  }

  /**
   * Publishes an HTTP or WebSocket service from an assigned Sandbox through an
   * owner-scoped AppKit route. A failed post-registration assignment check
   * removes the new route before rejecting.
   */
  async addRoute(
    client: WorkspaceClient,
    userId: string,
    input: AddSshRouteRequest,
    signal?: AbortSignal,
  ): Promise<SshRoute> {
    const request = addSshRouteRequestSchema.parse(input);
    const api = new DatabricksSandboxClient(client);
    await this.assertAssigned(api.workspaceScope(), userId, request.machineId);
    const epoch = this.runtimeEpoch(api.workspaceScope(), userId, request.machineId);
    const machine = await this.ensureRunning(api, userId, request.machineId, signal);
    const session = await this.ensureSession(client, userId, machine, epoch, signal);
    await this.assertAssigned(api.workspaceScope(), userId, request.machineId);
    this.assertRuntimeEpoch(api.workspaceScope(), userId, request.machineId, epoch);
    const route = await this.routes.add(session, { ...request, ownerId: userId });
    try {
      await this.assertAssigned(api.workspaceScope(), userId, request.machineId);
      this.assertRuntimeEpoch(api.workspaceScope(), userId, request.machineId, epoch);
      return route;
    } catch (error) {
      await this.routes.remove(route.id, userId);
      throw error;
    }
  }

  /** Removes one route only when it belongs to the given AppKit user. */
  removeRoute(userId: string, routeId: string): Promise<boolean> {
    return this.routes.remove(routeId, userId);
  }

  /** Lists public routes, optionally restricted to one AppKit user. */
  routeList(userId?: string): SshRoute[] {
    return this.routes.list(undefined, userId);
  }

  /** Returns the user-scoped route prefix beneath the configured root path. */
  routePathPrefix(userId: string): string {
    return this.routes.userPathPrefix(userId);
  }

  /** Invalidates and closes one cached SSH session without changing the remote Sandbox. */
  disconnect(workspaceScope: string, userId: string, machineId: string): void {
    const key = sessionKey(workspaceScope, userId, machineId);
    this.bumpEpoch(this.ownerEpochs, key);
    this.sessions.get(key)?.close();
    this.sessions.delete(key);
    this.connecting.delete(key);
  }

  /** Stops the reaper and closes sessions, routes, service state, and ownership resources. */
  async close(): Promise<void> {
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.reaperTimer = undefined;
    await this.reaping?.catch(() => undefined);
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.connecting.clear();
    this.services.clear();
    this.startingServices.clear();
    this.machineEpochs.clear();
    this.ownerEpochs.clear();
    await this.routes.close();
    await this.ownership?.close();
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
    managed: ManagedSandboxName;
  }> {
    const assignment = await this.ownershipStore().get(api.workspaceScope(), userId, machineId);
    const entry = assignment ? await api.get(machineId, signal) : undefined;
    const managed =
      entry && assignment ? this.validateManagedMachine(entry, assignment, userId) : undefined;
    if (!entry || !assignment || !managed) {
      throw new Error(
        `SSH machine ${machineId} is not assigned to the current user or has expired`,
      );
    }
    return { entry, assignment, managed };
  }

  private validateManagedMachine(
    entry: SandboxEntry,
    assignment: MachineAssignment,
    userId: string,
    now = Date.now(),
  ): ManagedSandboxName | undefined {
    if (!assignment.managedName || !assignment.expiresAt) return undefined;
    if (entry.name !== assignment.managedName) return undefined;
    const managed = parseManagedSandboxName(entry.name);
    if (!managed || managed.ownerId !== sandboxUserId(userId)) return undefined;
    const assignedExpiration = Date.parse(assignment.expiresAt);
    if (managed.expiresAtMs !== assignedExpiration || assignedExpiration <= now) return undefined;
    return managed;
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
    const assignmentsByMachine = new Map<string, MachineAssignment[]>();
    for (const assignment of assignments) {
      const current = assignmentsByMachine.get(assignment.machineId) ?? [];
      current.push(assignment);
      assignmentsByMachine.set(assignment.machineId, current);
    }

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
        removedAssignments += await ownership.unassignAll(workspaceScope, machineId);
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
      const managed = parseManagedSandboxName(entry.name);
      const machineAssignments = assignmentsByMachine.get(entry.sandboxId) ?? [];
      const assignment = machineAssignments.find(
        (candidate) =>
          candidate.managedName === entry.name &&
          candidate.expiresAt !== undefined &&
          managed?.ownerId === sandboxUserId(candidate.userId) &&
          managed.expiresAtMs === Date.parse(candidate.expiresAt),
      );
      const serviceManaged =
        isManagedSandboxNameCandidate(entry.name) || machineAssignments.length > 0;
      const expired = Boolean(managed && managed.expiresAtMs <= now);
      const invalid =
        serviceManaged && (!managed || !assignment || machineAssignments.length !== 1);
      if (!expired && !invalid) continue;

      try {
        await api.delete(entry.sandboxId, signal);
        removedAssignments += await ownership.unassignAll(workspaceScope, entry.sandboxId);
        await this.clearMachineRuntime(workspaceScope, entry.sandboxId);
        deleted += 1;
        logger.info("Sandbox reaper deleted managed machine", {
          machineId: entry.sandboxId,
          reason: expired ? "expired" : "invalid-managed-name-or-assignment",
        });
      } catch (error) {
        failures += 1;
        logger.warn("Sandbox reaper could not delete managed machine", {
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
  ): Promise<SandboxEntry> {
    const current = (await this.requireOwnedMachine(api, userId, machineId, signal)).entry;
    if (normalizeStatus(current.status) === "running") return current;
    if (!this.config.auto) {
      throw new Error(
        `SSH machine ${machineId} is ${current.status}; start it explicitly because auto is false`,
      );
    }
    const started = await api.start(machineId, signal);
    return waitForStatus(api, machineId, "running", started, signal);
  }

  private async ensureSession(
    client: WorkspaceClient,
    userId: string,
    machine: SandboxEntry,
    epoch: RuntimeEpoch,
    signal?: AbortSignal,
  ): Promise<SshSession> {
    const api = new DatabricksSandboxClient(client);
    const key = sessionKey(api.workspaceScope(), userId, machine.sandboxId);
    this.assertRuntimeEpoch(api.workspaceScope(), userId, machine.sandboxId, epoch);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const pending = this.connecting.get(key);
    if (pending) return pending;
    const connection = this.createSession(api, userId, machine, signal).finally(() => {
      if (this.connecting.get(key) === connection) this.connecting.delete(key);
    });
    this.connecting.set(key, connection);
    const session = await connection;
    if (this.connecting.get(key) !== connection) {
      session.close();
      throw new Error(`SSH machine ${machine.sandboxId} session was revoked`);
    }
    try {
      await this.assertAssigned(api.workspaceScope(), userId, machine.sandboxId);
      this.assertRuntimeEpoch(api.workspaceScope(), userId, machine.sandboxId, epoch);
    } catch (error) {
      session.close();
      throw error;
    }
    this.sessions.set(key, session);
    return session;
  }

  private async provisionService(
    client: WorkspaceClient,
    userId: string,
    request: SshMachineServiceAction,
    starting: SshMachineService,
    epoch: RuntimeEpoch,
    signal?: AbortSignal,
  ): Promise<SshMachineService> {
    const api = new DatabricksSandboxClient(client);
    const workspaceScope = api.workspaceScope();
    const key = serviceKey(workspaceScope, userId, request.machineId, request.service);
    logger.info("SSH machine service provisioning started", {
      userId,
      machineId: request.machineId,
      service: request.service,
      path: starting.path,
    });
    try {
      await this.assertAssigned(workspaceScope, userId, request.machineId);
      this.assertRuntimeEpoch(workspaceScope, userId, request.machineId, epoch);
      const machine = await this.ensureRunning(api, userId, request.machineId, signal);
      const session = await this.ensureSession(client, userId, machine, epoch, signal);
      const target = await ensureSshService(
        session,
        request.service,
        starting.path,
        Math.max(this.config.commandTimeoutMs, 600_000),
        signal,
      );
      await this.assertAssigned(workspaceScope, userId, request.machineId);
      this.assertRuntimeEpoch(workspaceScope, userId, request.machineId, epoch);
      const route = await this.routes.add(session, {
        ownerId: userId,
        machineId: request.machineId,
        path: starting.path,
        internal: true,
        ...target,
      });
      try {
        await this.assertAssigned(workspaceScope, userId, request.machineId);
        this.assertRuntimeEpoch(workspaceScope, userId, request.machineId, epoch);
      } catch (error) {
        await this.routes.remove(route.id, userId);
        throw error;
      }
      const ready: SshMachineService = { ...starting, state: "ready" };
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
    await session.connect();
    return session;
  }

  private toMachine(
    entry: SandboxEntry,
    workspaceScope: string,
    userId: string,
    assignment: MachineAssignment,
    managed: ManagedSandboxName,
  ): SshMachine {
    const status = normalizeStatus(entry.status);
    return {
      id: entry.sandboxId,
      name: managed.displayName,
      provider: "databricks-sandbox",
      status,
      ...(entry.gatewayHost ? { gatewayHost: entry.gatewayHost } : {}),
      ...(entry.createTime ? { createdAt: entry.createTime } : {}),
      expiresAt: assignment.expiresAt!,
      ...(entry.lastStartTime ? { lastStartedAt: entry.lastStartTime } : {}),
      ...(idleTimeoutSeconds(entry.idleTimeout) !== undefined
        ? { autoStopSeconds: idleTimeoutSeconds(entry.idleTimeout) }
        : {}),
      routes: this.routes.list(entry.sandboxId, userId),
      services: (["terminal", "stats"] as const).map(
        (kind): SshMachineService =>
          this.services.get(serviceKey(workspaceScope, userId, entry.sandboxId, kind)) ?? {
            kind,
            path: this.servicePath(entry.sandboxId, kind),
            state: "stopped",
          },
      ),
      canStart: status === "stopped" || status === "unknown" || status === "error",
      canStop: status === "running" || status === "starting",
      canConnect: Boolean(entry.gatewayHost) && status === "running",
    };
  }

  private servicePath(machineId: string, kind: SshMachineService["kind"]): string {
    const service = kind === "terminal" ? "terminal" : "metrics";
    const routePrefix = this.config.routePrefix.replace(/\/+$/, "");
    return `${routePrefix}/${service}/${machinePathSegment(machineId)}`;
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
    for (const [key, session] of this.sessions) {
      if (!sessionKeyMatchesMachine(key, workspaceScope, machineId)) continue;
      session.close();
      this.sessions.delete(key);
    }
    for (const key of this.connecting.keys()) {
      if (sessionKeyMatchesMachine(key, workspaceScope, machineId)) this.connecting.delete(key);
    }
    for (const key of this.services.keys()) {
      if (serviceKeyMatchesMachine(key, workspaceScope, machineId)) this.services.delete(key);
    }
    for (const key of this.startingServices.keys()) {
      if (serviceKeyMatchesMachine(key, workspaceScope, machineId)) {
        this.startingServices.delete(key);
      }
    }
    await this.routes.removeMachine(machineId);
  }

  private bumpEpoch(epochs: Map<string, number>, key: string): void {
    epochs.set(key, (epochs.get(key) ?? 0) + 1);
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
    await asyncUtils.sleep(POLL_INTERVAL_MS, signal);
    entry = await api.get(machineId, signal);
  }
  return entry;
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
