import type { WorkspaceClient } from "@databricks/appkit";
import { asyncUtils, errorUtils, log } from "@dbx-tools/shared-core";
import {
  addSshRouteRequestSchema,
  sshCommandRequestSchema,
  sshMachineServiceActionSchema,
  type AddSshRouteRequest,
  type SshCommandRequest,
  type SshCommandResult,
  type SshMachine,
  type SshMachineService,
  type SshMachineServiceAction,
  type SshMachinesResponse,
  type SshRoute,
} from "@dbx-tools/shared-databricks-sandbox";
import { z } from "zod";
import type { ResolvedSshPluginConfig } from "./config.ts";
import { SshKeyStore } from "./key-store.ts";
import {
  createMachineOwnershipStore,
  DiskMachineOwnershipStore,
  type MachineOwnershipStore,
} from "./ownership.ts";
import { DatabricksSandboxClient, isSandboxUnavailable, type SandboxEntry } from "./rest.ts";
import { SshRouteRegistry } from "./routes.ts";
import { ensureSshService } from "./services.ts";
import { SshSession } from "./session.ts";

const POLL_INTERVAL_MS = 1_000;
const LIFECYCLE_TIMEOUT_MS = 180_000;
const logger = log.logger("appkit-databricks-sandbox:auth");
const sandboxHttpResponseSchema = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

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

/** Coordinates Sandbox REST operations, SSH sessions, command execution, and web routes. */
export class SshRuntime {
  readonly routes: SshRouteRegistry;
  private readonly keys: SshKeyStore;
  private readonly sessions = new Map<string, SshSession>();
  private readonly connecting = new Map<string, Promise<SshSession>>();
  private ownership: MachineOwnershipStore;
  private readonly seededWorkspaces = new Set<string>();
  private readonly services = new Map<string, SshMachineService>();
  private readonly startingServices = new Map<string, Promise<SshMachineService>>();

  constructor(
    readonly config: ResolvedSshPluginConfig,
    ownership: MachineOwnershipStore = new DiskMachineOwnershipStore(config.ownershipPath),
  ) {
    this.keys = new SshKeyStore(config.keyDirectory);
    this.routes = new SshRouteRegistry(config.routePrefix);
    this.ownership = ownership;
  }

  /** Select Lakebase ownership storage when available, otherwise retain disk storage. */
  async initializeOwnership(
    pool?: Parameters<typeof createMachineOwnershipStore>[0]["pool"],
  ): Promise<void> {
    const next = await createMachineOwnershipStore({
      mode: this.config.ownershipStorage,
      path: this.config.ownershipPath,
      ...(pool ? { pool } : {}),
    });
    const previous = this.ownership;
    this.ownership = next;
    this.seededWorkspaces.clear();
    await previous.close();
  }

  /** Runs an OBO workspace operation and transparently retries it as the app service principal. */
  async withAuthFallback<T>(
    operation: WorkspaceAuthOperation,
    attempt: WorkspaceAuthAttempt<T>,
  ): Promise<T> {
    if (attempt.user) {
      logger.warn("SSH workspace auth attempt", {
        ...operation,
        identity: "user-obo",
      });
      try {
        const result = await attempt.user();
        logger.warn("SSH workspace auth succeeded", {
          ...operation,
          identity: "user-obo",
        });
        return result;
      } catch (error) {
        logger.warn("SSH workspace OBO failed", {
          ...operation,
          identity: "user-obo",
          ...authErrorMetadata(error),
        });
        if (!this.config.fallbackToServicePrincipal) throw error;
      }
    }

    logger.warn("SSH workspace auth fallback", {
      ...operation,
      identity: "app-service-principal",
    });
    try {
      const result = await attempt.servicePrincipal();
      logger.warn("SSH workspace auth succeeded", {
        ...operation,
        identity: "app-service-principal",
      });
      return result;
    } catch (error) {
      logger.warn("SSH workspace service-principal failed", {
        ...operation,
        identity: "app-service-principal",
        ...authErrorMetadata(error),
      });
      throw error;
    }
  }

  async listMachines(
    client: WorkspaceClient,
    userId: string,
    signal?: AbortSignal,
  ): Promise<SshMachinesResponse> {
    const api = new DatabricksSandboxClient(client);
    try {
      await this.seedAssignments(api.workspaceScope());
      const assigned = await this.ownership.listMachineIds(api.workspaceScope(), userId);
      const entries = await api.list(signal);
      return {
        auto: this.config.auto,
        supported: true,
        machines: entries
          .filter((entry) => assigned.has(entry.sandboxId))
          .map((entry) => this.toMachine(entry, userId)),
      };
    } catch (error) {
      if (isSandboxUnavailable(error)) {
        return { auto: this.config.auto, supported: false, machines: [] };
      }
      throw error;
    }
  }

  async startMachine(
    client: WorkspaceClient,
    userId: string,
    machineId: string,
    signal?: AbortSignal,
  ): Promise<SshMachine> {
    const api = new DatabricksSandboxClient(client);
    await this.assertAssigned(api.workspaceScope(), userId, machineId);
    const current = await api.get(machineId, signal);
    const updated =
      normalizeStatus(current.status) === "running" ? current : await api.start(machineId, signal);
    const final = await waitForStatus(api, machineId, "running", updated, signal);
    await Promise.allSettled(
      (["terminal", "stats"] as const).map((service) =>
        this.startService(client, userId, { machineId, service }, signal),
      ),
    );
    return this.toMachine(final, userId);
  }

  async stopMachine(
    client: WorkspaceClient,
    userId: string,
    machineId: string,
    signal?: AbortSignal,
  ): Promise<SshMachine> {
    const api = new DatabricksSandboxClient(client);
    await this.assertAssigned(api.workspaceScope(), userId, machineId);
    const current = await api.get(machineId, signal);
    const updated =
      normalizeStatus(current.status) === "stopped" ? current : await api.stop(machineId, signal);
    const final = await waitForStatus(api, machineId, "stopped", updated, signal);
    this.disconnect(api.workspaceScope(), userId, machineId);
    await this.routes.removeMachine(machineId, userId);
    for (const kind of ["terminal", "stats"] as const) {
      this.services.delete(serviceKey(userId, machineId, kind));
    }
    return this.toMachine(final, userId);
  }

  async startService(
    client: WorkspaceClient,
    userId: string,
    input: SshMachineServiceAction,
    signal?: AbortSignal,
  ): Promise<SshMachineService> {
    const request = sshMachineServiceActionSchema.parse(input);
    const key = serviceKey(userId, request.machineId, request.service);
    const current = this.services.get(key);
    if (
      current?.state === "ready" &&
      this.routes.list(request.machineId, userId).some((route) => route.path === current.path)
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
    const operation = this.provisionService(client, userId, request, starting, signal).finally(
      () => {
        this.startingServices.delete(key);
      },
    );
    this.startingServices.set(key, operation);
    return operation;
  }

  async execute(
    client: WorkspaceClient,
    userId: string,
    input: SshCommandRequest,
    signal?: AbortSignal,
  ): Promise<SshCommandResult> {
    const request = sshCommandRequestSchema.parse(input);
    const api = new DatabricksSandboxClient(client);
    await this.assertAssigned(api.workspaceScope(), userId, request.machineId);
    const machine = await this.ensureRunning(api, request.machineId, signal);
    const timeoutMs = request.timeoutMs ?? this.config.commandTimeoutMs;
    try {
      const session = await this.ensureSession(client, userId, machine, signal);
      return await session.execute(request.command, request.args, {
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.env ? { env: request.env } : {}),
        timeoutMs,
        signal,
      });
    } catch (error) {
      if (!this.config.fallbackToSandboxExec || !isSshGatewayUnavailable(error)) throw error;
      logger.warn("SSH gateway unavailable; using Sandbox execution REST API", {
        machineId: request.machineId,
        userId,
        ...authErrorMetadata(error),
      });
      return api.execute(request.machineId, request, timeoutMs, signal);
    }
  }

  async addRoute(
    client: WorkspaceClient,
    userId: string,
    input: AddSshRouteRequest,
    signal?: AbortSignal,
  ): Promise<SshRoute> {
    const request = addSshRouteRequestSchema.parse(input);
    const api = new DatabricksSandboxClient(client);
    await this.assertAssigned(api.workspaceScope(), userId, request.machineId);
    const machine = await this.ensureRunning(api, request.machineId, signal);
    try {
      const session = await this.ensureSession(client, userId, machine, signal);
      return await this.routes.add(session, { ...request, ownerId: userId });
    } catch (error) {
      if (!this.config.fallbackToSandboxExec || !isSshGatewayUnavailable(error)) throw error;
      logger.warn("SSH gateway unavailable; using Sandbox HTTP execution proxy", {
        machineId: request.machineId,
        userId,
        ...authErrorMetadata(error),
      });
      return this.routes.addExecutor({ ...request, ownerId: userId }, async ({ method, url }) => {
        if (method !== "GET" && method !== "HEAD") {
          return {
            status: 405,
            headers: { "content-type": "text/plain; charset=utf-8" },
            body: new TextEncoder().encode("Sandbox execution proxy supports GET and HEAD"),
          };
        }
        const target = new URL(
          url,
          `http://${request.remoteHost}:${request.remotePort}`,
        ).toString();
        const script = [
          "import base64, json, sys, urllib.error, urllib.request",
          "request = urllib.request.Request(sys.argv[1], method=sys.argv[2])",
          "try:",
          "    response = urllib.request.urlopen(request, timeout=30)",
          "except urllib.error.HTTPError as error:",
          "    response = error",
          "body = response.read()",
          "print(json.dumps({'status': response.status, 'headers': dict(response.headers.items()), 'body': base64.b64encode(body).decode()}))",
        ].join("\n");
        const result = await api.execute(
          request.machineId,
          {
            machineId: request.machineId,
            command: "python3",
            args: ["-c", script, target, method],
          },
          this.config.commandTimeoutMs,
          signal,
        );
        if (!result.success) {
          throw new Error(result.stderr || `Sandbox HTTP proxy exited ${result.exitCode}`);
        }
        const response = sandboxHttpResponseSchema.parse(
          JSON.parse(result.stdout.trim().split("\n").at(-1) ?? ""),
        );
        return {
          status: response.status,
          headers: response.headers,
          body: Uint8Array.from(Buffer.from(response.body, "base64")),
        };
      });
    }
  }

  removeRoute(userId: string, routeId: string): Promise<boolean> {
    return this.routes.remove(routeId, userId);
  }

  routeList(userId?: string): SshRoute[] {
    return this.routes.list(undefined, userId);
  }

  /** Manually assign one existing machine to an AppKit user. */
  async assignMachine(client: WorkspaceClient, userId: string, machineId: string): Promise<void> {
    const api = new DatabricksSandboxClient(client);
    await api.get(machineId);
    await this.ownership.assign(api.workspaceScope(), userId, machineId);
  }

  /** Remove one explicit AppKit user-to-machine assignment. */
  async unassignMachine(
    client: WorkspaceClient,
    userId: string,
    machineId: string,
  ): Promise<boolean> {
    const api = new DatabricksSandboxClient(client);
    return this.ownership.unassign(api.workspaceScope(), userId, machineId);
  }

  disconnect(workspaceScope: string, userId: string, machineId: string): void {
    const key = sessionKey(workspaceScope, userId, machineId);
    this.sessions.get(key)?.close();
    this.sessions.delete(key);
    this.connecting.delete(key);
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.connecting.clear();
    this.services.clear();
    this.startingServices.clear();
    await this.routes.close();
    await this.ownership.close();
  }

  private async seedAssignments(workspaceScope: string): Promise<void> {
    if (this.seededWorkspaces.has(workspaceScope)) return;
    for (const assignment of this.config.machineAssignments) {
      if (assignment.workspaceScope && assignment.workspaceScope !== workspaceScope) continue;
      await this.ownership.assign(workspaceScope, assignment.userId, assignment.machineId);
    }
    this.seededWorkspaces.add(workspaceScope);
  }

  private async assertAssigned(
    workspaceScope: string,
    userId: string,
    machineId: string,
  ): Promise<void> {
    await this.seedAssignments(workspaceScope);
    if (await this.ownership.has(workspaceScope, userId, machineId)) return;
    throw new Error(`SSH machine ${machineId} is not assigned to the current user`);
  }

  private async ensureRunning(
    api: DatabricksSandboxClient,
    machineId: string,
    signal?: AbortSignal,
  ): Promise<SandboxEntry> {
    const current = await api.get(machineId, signal);
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
    signal?: AbortSignal,
  ): Promise<SshSession> {
    const api = new DatabricksSandboxClient(client);
    const key = sessionKey(api.workspaceScope(), userId, machine.sandboxId);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const pending = this.connecting.get(key);
    if (pending) return pending;
    const connection = this.createSession(api, userId, machine, signal).finally(() => {
      this.connecting.delete(key);
    });
    this.connecting.set(key, connection);
    const session = await connection;
    this.sessions.set(key, session);
    return session;
  }

  private async provisionService(
    client: WorkspaceClient,
    userId: string,
    request: SshMachineServiceAction,
    starting: SshMachineService,
    signal?: AbortSignal,
  ): Promise<SshMachineService> {
    const key = serviceKey(userId, request.machineId, request.service);
    logger.warn("SSH machine service provisioning started", {
      userId,
      machineId: request.machineId,
      service: request.service,
      path: starting.path,
    });
    try {
      const api = new DatabricksSandboxClient(client);
      await this.assertAssigned(api.workspaceScope(), userId, request.machineId);
      const machine = await this.ensureRunning(api, request.machineId, signal);
      const session = await this.ensureSession(client, userId, machine, signal);
      const target = await ensureSshService(
        session,
        request.service,
        starting.path,
        Math.max(this.config.commandTimeoutMs, 600_000),
        signal,
      );
      await this.routes.add(session, {
        ownerId: userId,
        machineId: request.machineId,
        path: starting.path,
        ...target,
      });
      const ready: SshMachineService = { ...starting, state: "ready" };
      this.services.set(key, ready);
      logger.warn("SSH machine service provisioning succeeded", {
        userId,
        machineId: request.machineId,
        service: request.service,
        path: ready.path,
        remoteHost: target.remoteHost,
        remotePort: target.remotePort,
      });
      return ready;
    } catch (error) {
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
        ...authErrorMetadata(error),
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

  private toMachine(entry: SandboxEntry, userId: string): SshMachine {
    const status = normalizeStatus(entry.status);
    return {
      id: entry.sandboxId,
      name: entry.name?.trim() || entry.sandboxId,
      provider: "databricks-sandbox",
      status,
      ...(entry.gatewayHost ? { gatewayHost: entry.gatewayHost } : {}),
      ...(entry.createTime ? { createdAt: entry.createTime } : {}),
      ...(entry.lastStartTime ? { lastStartedAt: entry.lastStartTime } : {}),
      ...(idleTimeoutSeconds(entry.idleTimeout) !== undefined
        ? { autoStopSeconds: idleTimeoutSeconds(entry.idleTimeout) }
        : {}),
      routes: this.routes.list(entry.sandboxId, userId),
      services: (["terminal", "stats"] as const).map(
        (kind): SshMachineService =>
          this.services.get(serviceKey(userId, entry.sandboxId, kind)) ?? {
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
    const prefix = this.config.routePrefix.replace(/\/$/, "");
    return `${prefix}/${machinePathSegment(machineId)}/${kind}`;
  }
}

function serviceKey(userId: string, machineId: string, kind: SshMachineService["kind"]): string {
  return `${userId}\0${machineId}\0${kind}`;
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

function authErrorMetadata(error: unknown): Record<string, unknown> {
  const record = isRecord(error) ? error : {};
  const response = isRecord(record.response) ? record.response : {};
  const body = record.body ?? response.body ?? response.data;
  return {
    errorName: error instanceof Error ? error.name : undefined,
    errorMessage: errorUtils.errorMessage(error),
    status: record.status ?? record.statusCode ?? response.status,
    statusText: response.statusText,
    errorCode: record.errorCode ?? record.error_code ?? bodyField(body, "error_code"),
    requestId: record.requestId ?? record.request_id ?? bodyField(body, "request_id"),
    responseBody: safeBody(body),
    cause: error instanceof Error && error.cause ? safeBody(error.cause) : undefined,
  };
}

function bodyField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSshGatewayUnavailable(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    if (!isRecord(current)) continue;
    if (
      current.code === "EHOSTUNREACH" ||
      current.code === "ENETUNREACH" ||
      current.code === "ECONNREFUSED" ||
      current.code === "ETIMEDOUT"
    ) {
      return true;
    }
    if (current.cause) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
  return false;
}
