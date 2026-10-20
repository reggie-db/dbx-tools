import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { onParentTerminationSignal } from "@dbx-tools/core";
import {
  SshKeyStore,
  ensureLakeboxRunning,
  ensureLakeboxStopped,
  lakeboxIdleTimeoutSeconds,
  normalizeLakeboxStatus,
  SshCommand,
  SshSession,
} from "@dbx-tools/lakebox";
import {
  isLakeboxUnavailable,
  LakeboxApiError,
  LakeboxClient,
  type LakeboxAuth,
  type LakeboxEntry,
} from "@dbx-tools/lakebox";
import { errorNodes, log, sleep, toError } from "@dbx-tools/shared-core";
import {
  LAKEBOX_BUILT_IN_SERVICES,
  lakeboxBuiltInServiceNameSchema,
  lakeboxCommandRequestSchema,
  lakeboxServiceLogsRequestSchema,
  type CreateLakeboxServiceRequest,
  type LakeboxBuiltInServiceName,
  type LakeboxCommandRequest,
  type LakeboxMetricsResponse,
  type LakeboxMetricsSnapshot,
  type LakeboxService,
  type LakeboxServiceLogsRequest,
  type LakeboxStatus,
  type LakeboxSummary,
  type LakeboxUser,
} from "@dbx-tools/shared-lakebox";
import { readPackageResource } from "./_package.ts";
import { LakeboxResourceRegistry } from "./_resource-registry.ts";
import { LakeboxServiceSnapshots, stoppedSnapshotServices } from "./_service-snapshots.ts";
import type { ResolvedLakeboxPluginConfig } from "./config.ts";
import { LakeboxMetrics } from "./metrics.ts";
import { LakeboxRouteRegistry, type LakeboxRouteResolution } from "./routes.ts";
import {
  builtInDefinition,
  idleBuiltInService,
  imageDefinition,
  LakeboxControllerServiceSchema,
  serviceRoute,
  toLakeboxService,
  type LakeboxControllerDefinition,
  type LakeboxControllerService,
} from "./services.ts";
import { LAKEBOX_RUNTIME_ROOT, lakeboxUser } from "./user.ts";

const ADMIN_SCRIPT = readPackageResource("scripts", "lakebox-admin.sh");
const HELPERS = {
  "lakebox-service": readPackageResource("scripts", "lakebox-service.py"),
  "desktop-session": readPackageResource("scripts", "desktop-session.sh"),
  "desktop-prerequisites": readPackageResource("scripts", "desktop-prerequisites.sh"),
} as const;
const CONTROLLER = `${LAKEBOX_RUNTIME_ROOT}/bin/lakebox-service`;
const ENTRY_TTL_MS = 5_000;
const SETUP_TIMEOUT_MS = 600_000;
const SSH_READY_TIMEOUT_MS = 300_000;
const SSH_READY_RETRY_INITIAL_MS = 1_000;
const SSH_READY_RETRY_MAX_MS = 10_000;
const TRANSIENT_SSH_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);
const METRICS_LEASE_MS = 60_000;
const IDLE_CHECK_MS = 30_000;
const SSH_KEY_OWNER = "app-service-principal";
const LEGACY_NAME =
  /^dbx-(?!lakebox-)[a-z]+-[a-z]+-[0-9a-f]{8}(?:_uid_[A-Za-z0-9_-]+_exp_[0-9]+)?$/;
const LEGACY_SCHEMA_PREFIX = "dbx_tools_databricks_sandbox";
const logger = log.logger("appkit-lakebox:runtime");

/** Whether the platform is running but its SSH gateway is still becoming reachable. */
function _isTransientSshStartupError(error: unknown): boolean {
  return [...errorNodes(error)].some(
    (node) =>
      typeof node === "object" &&
      "code" in node &&
      TRANSIENT_SSH_CODES.has(String((node as { code?: unknown }).code)),
  );
}

/** Resolves the authenticated identity for raw request headers. */
export type LakeboxIdentityResolver = (headers: IncomingHttpHeaders) => string | undefined;

/** Minimal Lakebase pool used to drop legacy ownership schemas. */
export interface LakeboxLegacyPool {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

interface Boot {
  key: string;
  entry: LakeboxEntry;
  session: SshSession;
  users: Map<string, Promise<void>>;
  services: Map<string, Map<string, LakeboxControllerService>>;
  starting: Map<string, Promise<LakeboxService>>;
  desktop?: Promise<void>;
}

interface ServiceListing {
  services: LakeboxService[];
  stale: boolean;
  observedAt?: string;
}

/**
 * Owns the single lazily created Lakebox of one application.
 *
 * Every Databricks Lakebox REST call uses the app service principal supplied
 * through {@link initialize}; request identity only selects the internal Linux
 * account. Each authenticated identity maps through one FNV-1a hash to a locked
 * account, persistent home, route segment, and service ports. Lifecycle and
 * per-boot bootstrap are serialized in-process; the persistent resource
 * registry serializes first creation across replicas.
 */
export class LakeboxRuntime {
  readonly routes: LakeboxRouteRegistry;
  readonly metrics: LakeboxMetrics;
  private readonly keys: SshKeyStore;
  private readonly stopParentTerminationSignal: () => void;
  private readonly shutdownController = new AbortController();
  private api?: LakeboxClient;
  private identity: LakeboxIdentityResolver = () => undefined;
  /** In-memory identities of routed users; never persisted. */
  private readonly routedIdentities = new Map<string, string>();
  private cached?: { entry?: LakeboxEntry; at: number };
  private boot?: Boot;
  /** Last boot that completed runtime bootstrap and produced a metrics sample. */
  private readyBootKey?: string;
  private converging?: Promise<Boot>;
  private waking?: Promise<unknown>;
  private metricsLease?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setInterval>;
  private lastActivity = Date.now();
  private activeCommands = 0;
  /** Last service states per user hash, kept after an idle session release. */
  private readonly lastServices = new Map<string, Map<string, LakeboxControllerService>>();
  private readonly lastServicesObservedAt = new Map<string, string>();
  private resourceRegistry?: LakeboxResourceRegistry;
  private serviceSnapshots?: LakeboxServiceSnapshots;
  private closing?: Promise<void>;

  /** Creates a runtime from resolved plugin configuration. */
  constructor(readonly config: ResolvedLakeboxPluginConfig) {
    this.keys = new SshKeyStore(config.keyDirectory);
    this.routes = new LakeboxRouteRegistry(config.routePrefix, {
      user: (headers) => {
        const identity = this.identity(headers);
        if (!identity) return undefined;
        const user = this.user(identity);
        this.routedIdentities.set(user.hash, identity);
        return user;
      },
      resolve: (user, service) => this.resolveRoute(user, service),
      unavailable: (user, service) => this.markUnavailable(user, service),
    });
    this.metrics = new LakeboxMetrics(
      (signal) => this.readMetrics(signal),
      config.metricsIntervalSeconds * 1_000,
    );
    this.stopParentTerminationSignal = onParentTerminationSignal(() => this.routes.beginShutdown());
  }

  /**
   * Supplies app service-principal credentials and the request identity
   * resolver used by routes.
   */
  initialize(
    auth: LakeboxAuth,
    identity?: LakeboxIdentityResolver,
    serviceSnapshots?: LakeboxServiceSnapshots,
    resourceRegistry?: LakeboxResourceRegistry,
  ): void {
    this.api = new LakeboxClient(auth);
    if (identity) this.identity = identity;
    if (serviceSnapshots) this.serviceSnapshots = serviceSnapshots;
    if (resourceRegistry) this.resourceRegistry = resourceRegistry;
  }

  /** Derives the Lakebox account for one authenticated identity. */
  user(identity: string): LakeboxUser {
    return lakeboxUser(identity, this.config.routePrefix);
  }

  /** Summarizes the app Lakebox for one user without creating it. */
  async summary(identity: string, signal?: AbortSignal): Promise<LakeboxSummary> {
    const user = this.user(identity);
    const base = { auto: this.config.auto, name: "Lakebox", user };
    let entry: LakeboxEntry | undefined;
    try {
      entry = await this.entry(signal, true);
    } catch (error) {
      if (isLakeboxUnavailable(error)) {
        return {
          ...base,
          supported: false,
          status: "missing",
          services: [],
          servicesStale: false,
          canStart: false,
          canStop: false,
        };
      }
      throw error;
    }
    const platformStatus: LakeboxStatus = entry ? normalizeLakeboxStatus(entry.status) : "missing";
    const status = this.productStatus(entry, platformStatus);
    if (entry && platformStatus === "running" && status === "starting") {
      this.wake(() => this.ready());
    }
    const listing = await this.serviceListing(identity, user, entry, status, signal);
    return {
      ...base,
      supported: true,
      status,
      ...(entry ? { id: entry.sandboxId } : {}),
      ...(lakeboxIdleTimeoutSeconds(entry?.idleTimeout) !== undefined
        ? { idleTimeoutSeconds: lakeboxIdleTimeoutSeconds(entry?.idleTimeout) }
        : {}),
      services: listing.services,
      servicesStale: listing.stale,
      ...(listing.observedAt ? { servicesObservedAt: listing.observedAt } : {}),
      canStart: status !== "running" && status !== "starting",
      canStop: status === "running" || status === "starting",
    };
  }

  /** Creates the Lakebox when needed, starts it, and restores saved services. */
  async start(signal?: AbortSignal): Promise<void> {
    await this.ready(signal, true);
  }

  /** Stops the shared Lakebox for every user. Files and saved services persist. */
  async stop(signal?: AbortSignal): Promise<void> {
    const entry = await this.entry(signal, true);
    if (!entry) return;
    await this.discardBoot();
    await ensureLakeboxStopped(this.client(), entry, signal);
    this.cached = undefined;
  }

  /** Permanently deletes the managed Lakebox and every user's files. */
  async delete(signal?: AbortSignal): Promise<boolean> {
    const entry = await this.entry(signal, true);
    if (!entry) return false;
    await this.discardBoot();
    await this.client().delete(entry.sandboxId, signal);
    await this.resources().clear(this.client());
    this.readyBootKey = undefined;
    this.cached = { at: Date.now() };
    return true;
  }

  /**
   * Runs one command as the user's account, creating or starting the Lakebox
   * when `auto` is enabled.
   */
  execute(identity: string, input: LakeboxCommandRequest, signal?: AbortSignal): SshCommand {
    const request = lakeboxCommandRequestSchema.parse(input);
    const timeoutMs = request.timeoutMs ?? this.config.commandTimeoutMs;
    const user = this.user(identity);
    return new SshCommand(
      request.command,
      request.args,
      { timeoutMs, signal },
      async (execution) => {
        const boot = await this.readyUser(user, identity, execution.signal);
        this.activeCommands += 1;
        try {
          return await execution.follow(
            boot.session.execute(request.command, request.args, {
              user,
              ...(request.cwd ? { cwd: request.cwd } : {}),
              ...(request.env ? { env: request.env } : {}),
              timeoutMs,
              signal: execution.signal,
            }),
          );
        } finally {
          this.activeCommands -= 1;
          this.touch();
        }
      },
    );
  }

  /** Lists the user's services, including idle built-ins. Never creates the Lakebox. */
  async listServices(identity: string, signal?: AbortSignal): Promise<LakeboxService[]> {
    const user = this.user(identity);
    const entry = await this.entry(signal);
    const status: LakeboxStatus = entry ? normalizeLakeboxStatus(entry.status) : "missing";
    return (await this.serviceListing(identity, user, entry, status, signal)).services;
  }

  /** Creates or replaces one image service and waits until it is ready or failed. */
  async createService(
    identity: string,
    input: CreateLakeboxServiceRequest,
    signal?: AbortSignal,
  ): Promise<LakeboxService> {
    const user = this.user(identity);
    const definition = imageDefinition(input, user);
    const boot = await this.readyUser(user, identity, signal);
    await this.controller(boot, user, "put", [encode(definition)], signal);
    return this.runService(boot, user, definition, signal);
  }

  /** Starts a saved service or a built-in and waits until it is ready or failed. */
  async startService(
    identity: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<LakeboxService> {
    const user = this.user(identity);
    const boot = await this.readyUser(user, identity, signal);
    const builtIn = lakeboxBuiltInServiceNameSchema.safeParse(name);
    if (builtIn.success) {
      const definition = builtInDefinition(builtIn.data, user);
      await this.controller(boot, user, "put", [encode(definition)], signal);
      return this.runService(boot, user, definition, signal);
    }
    const saved = (await this.refreshServices(boot, user, identity, signal)).get(name);
    if (!saved) throw new Error(`Lakebox service ${name} does not exist`);
    return this.runService(boot, user, saved.definition, signal);
  }

  /** Stops one running service without removing its definition. */
  async stopService(identity: string, name: string, signal?: AbortSignal): Promise<LakeboxService> {
    const user = this.user(identity);
    const boot = await this.readyUser(user, identity, signal);
    const stopped = LakeboxControllerServiceSchema.parse(
      await this.controller(boot, user, "stop", [name], signal),
    );
    this.cacheService(boot, user, stopped);
    return toLakeboxService(stopped, user, this.config.routePrefix);
  }

  /** Stops and deletes one saved service. Mounted home directories are preserved. */
  async removeService(identity: string, name: string, signal?: AbortSignal): Promise<boolean> {
    const user = this.user(identity);
    const boot = await this.readyUser(user, identity, signal);
    const result = (await this.controller(boot, user, "remove", [name], signal)) as {
      removed?: boolean;
    };
    if (result.removed === true) await this.refreshServices(boot, user, identity, signal);
    return result.removed === true;
  }

  /** Reads a bounded tail of one service log. */
  async serviceLogs(
    identity: string,
    input: LakeboxServiceLogsRequest,
    signal?: AbortSignal,
  ): Promise<{ log: string }> {
    const request = lakeboxServiceLogsRequestSchema.parse(input);
    const user = this.user(identity);
    const entry = await this.entry(signal);
    if (!entry || normalizeLakeboxStatus(entry.status) !== "running") return { log: "" };
    const boot = await this.readyUser(user, identity, signal);
    const result = (await this.controller(
      boot,
      user,
      "logs",
      [request.name, String(request.maxLines), String(request.maxChars)],
      signal,
    )) as { log?: string };
    return { log: result.log ?? "" };
  }

  /**
   * Returns recent metrics and keeps sampling for one lease interval. Sampling
   * runs only while the Lakebox runs and a caller is watching, so metrics never
   * keep an otherwise idle Lakebox awake.
   */
  async metricsResponse(signal?: AbortSignal): Promise<LakeboxMetricsResponse> {
    const entry = await this.entry(signal);
    const platformStatus: LakeboxStatus = entry ? normalizeLakeboxStatus(entry.status) : "missing";
    if (platformStatus !== "running") {
      this.metrics.stop();
      return { status: platformStatus, series: [] };
    }
    if (!entry || !this.boot || this.boot.key !== this.bootKey(entry)) {
      this.metrics.stop();
      this.wake(() => this.ready());
      return { status: "starting", series: [] };
    }
    this.leaseMetrics();
    return {
      status: this.productStatus(entry, platformStatus),
      series: [...this.metrics.series()],
    };
  }

  /** Subscribes to metrics snapshots while the Lakebox runs. */
  subscribeMetrics(listener: (snapshot: LakeboxMetricsSnapshot) => void): () => void {
    this.metrics.on("snapshot", listener);
    if (this.boot?.key === this.readyBootKey) this.metrics.start();
    return () => {
      this.metrics.off("snapshot", listener);
      this.leaseMetrics();
    };
  }

  /**
   * Deletes legacy per-user Lakeboxes and drops legacy ownership schemas.
   *
   * There is no migration: the earlier one-machine-per-user model is removed.
   * The managed app Lakebox and Lakeboxes with other names are never touched.
   */
  async cleanupLegacy(pool?: LakeboxLegacyPool, signal?: AbortSignal): Promise<void> {
    try {
      const entries = await this.client().list(signal);
      await Promise.all(
        entries
          .filter((entry) => entry.name && LEGACY_NAME.test(entry.name))
          .map(async (entry) => {
            await this.client().delete(entry.sandboxId, signal);
            logger.info("deleted legacy per-user Lakebox", {
              id: entry.sandboxId,
              name: entry.name,
            });
          }),
      );
    } catch (error) {
      if (!isLakeboxUnavailable(error)) {
        logger.warn("legacy Lakebox cleanup failed", { error: toError(error) });
      }
    }
    if (!pool) return;
    try {
      const schemas = await pool.query(
        "SELECT nspname FROM pg_namespace WHERE nspname = $1 OR starts_with(nspname, $2)",
        [LEGACY_SCHEMA_PREFIX, `${LEGACY_SCHEMA_PREFIX}_`],
      );
      for (const row of schemas.rows) {
        const schema = String(row.nspname);
        await pool.query(`DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`);
        logger.info("dropped legacy Lakebox ownership schema", { schema });
      }
    } catch (error) {
      logger.warn("legacy ownership schema cleanup failed", { error: toError(error) });
    }
  }

  /** Cancels in-flight work before teardown. */
  abortActiveOperations(): void {
    if (!this.shutdownController.signal.aborted) this.shutdownController.abort();
  }

  /** Closes routes, metrics, and the SSH session without changing the Lakebox. */
  close(): Promise<void> {
    this.abortActiveOperations();
    this.routes.beginShutdown();
    this.closing ??= (async () => {
      try {
        if (this.metricsLease) clearTimeout(this.metricsLease);
        this.metrics.stop();
        await this.routes.close();
        await this.boot?.session.close();
        this.boot = undefined;
      } finally {
        this.stopParentTerminationSignal();
      }
    })();
    return this.closing;
  }

  private client(): LakeboxClient {
    if (!this.api) throw new Error("The Lakebox runtime has no app service-principal credentials");
    return this.api;
  }

  private resources(): LakeboxResourceRegistry {
    if (!this.resourceRegistry) throw new Error("The Lakebox runtime has no resource registry");
    return this.resourceRegistry;
  }

  /** Returns the managed Lakebox entry, cached briefly to keep routes cheap. */
  private async entry(signal?: AbortSignal, fresh = false): Promise<LakeboxEntry | undefined> {
    if (!fresh && this.cached && Date.now() - this.cached.at < ENTRY_TTL_MS) {
      return this.cached.entry;
    }
    const entry = await this.resources().read(this.client(), signal);
    this.cached = { ...(entry ? { entry } : {}), at: Date.now() };
    if (!entry || normalizeLakeboxStatus(entry.status) !== "running") {
      this.readyBootKey = undefined;
    }
    if (this.boot && (!entry || this.bootKey(entry) !== this.boot.key)) await this.discardBoot();
    return entry;
  }

  private bootKey(entry: LakeboxEntry): string {
    return `${entry.sandboxId}\0${entry.lastStartTime ?? ""}`;
  }

  private productStatus(entry: LakeboxEntry | undefined, status: LakeboxStatus): LakeboxStatus {
    return entry && status === "running" && this.readyBootKey !== this.bootKey(entry)
      ? "starting"
      : status;
  }

  /** Serializes create, start, connect, and bootstrap for the current boot. */
  private ready(signal?: AbortSignal, explicit = false): Promise<Boot> {
    const current = this.boot;
    if (current && this.cached?.entry && this.bootKey(this.cached.entry) === current.key) {
      if (Date.now() - this.cached.at < ENTRY_TTL_MS) return Promise.resolve(current);
    }
    this.converging ??= this.converge(signal, explicit).finally(() => {
      this.converging = undefined;
    });
    return this.converging;
  }

  private async converge(signal: AbortSignal | undefined, explicit: boolean): Promise<Boot> {
    const operationSignal = signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;
    let entry = await this.entry(operationSignal, true);
    if (!entry || normalizeLakeboxStatus(entry.status) !== "running") {
      if (!this.config.auto && !explicit) {
        throw new Error(
          `Lakebox is ${entry ? entry.status : "not created"}; start it explicitly because auto is false`,
        );
      }
    }
    entry ??= await this.resources().getOrCreate(this.client(), operationSignal);
    if (lakeboxIdleTimeoutSeconds(entry.idleTimeout) !== this.config.idleTimeoutSeconds) {
      entry = await this.client().setIdleTimeout(
        entry.sandboxId,
        this.config.idleTimeoutSeconds,
        operationSignal,
      );
    }
    entry = await ensureLakeboxRunning(this.client(), entry, operationSignal);
    this.cached = { entry, at: Date.now() };
    const key = this.bootKey(entry);
    if (this.boot?.key === key) return this.boot;
    await this.discardBoot();
    const session = await this.connect(entry, operationSignal);
    const boot: Boot = {
      key,
      entry,
      session,
      users: new Map(),
      services: new Map(),
      starting: new Map(),
    };
    try {
      const restored = await this.bootstrap(session, operationSignal);
      this.metrics.stop();
      this.metrics.seed((await this.admin(session, ["metrics"], operationSignal)).stdout);
      this.boot = boot;
      this.readyBootKey = key;
      this.watchIdle();
      if (this.metrics.listenerCount("snapshot") > 0) this.metrics.start();
      for (const hash of restored) void this.restoreUser(boot, hash);
      return boot;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  private async connect(entry: LakeboxEntry, signal: AbortSignal): Promise<SshSession> {
    const startedAt = Date.now();
    let attempt = 0;
    while (true) {
      try {
        return await this.connectOnce(entry, signal);
      } catch (error) {
        attempt += 1;
        if (!_isTransientSshStartupError(error) || Date.now() - startedAt >= SSH_READY_TIMEOUT_MS) {
          throw error;
        }
        const delayMs = Math.min(
          SSH_READY_RETRY_INITIAL_MS * 2 ** (attempt - 1),
          SSH_READY_RETRY_MAX_MS,
        );
        logger.info("Lakebox SSH gateway is not ready; retrying", {
          attempt,
          delayMs,
        });
        await this.waitForSshRetry(delayMs, signal);
      }
    }
  }

  private waitForSshRetry(delayMs: number, signal: AbortSignal): Promise<void> {
    return sleep(delayMs, signal);
  }

  private async connectOnce(entry: LakeboxEntry, signal: AbortSignal): Promise<SshSession> {
    const api = this.client();
    const scope = await api.workspaceScope();
    const key = await this.keys.ensureRegistered(api, SSH_KEY_OWNER, signal);
    const gatewayHost = entry.gatewayHost ?? key.gatewayHost;
    if (!gatewayHost) throw new Error("Databricks Lakebox did not return an SSH gateway host");
    const port = this.config.gatewayPort;
    const knownHost = await this.keys.knownHost(scope, SSH_KEY_OWNER, gatewayHost, port);
    const session = new SshSession({
      host: gatewayHost,
      port,
      username: entry.sandboxId,
      privateKey: key.privateKey,
      privateKeyPath: key.privateKeyPath,
      knownHostsPath: this.keys.knownHostsPath(scope, SSH_KEY_OWNER, gatewayHost, port),
      connectTimeoutMs: this.config.connectTimeoutMs,
      sshTransport: this.config.sshTransport,
      ssh2Patch: this.config.ssh2Patch,
      ...(knownHost ? { knownHost } : {}),
      rememberHost: (fingerprint, hostKey) =>
        this.keys.rememberHost(scope, SSH_KEY_OWNER, gatewayHost, port, fingerprint, hostKey),
    });
    try {
      await session.connect();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  /** Runs the fixed privileged bootstrap and returns the restored user hashes. */
  private async bootstrap(session: SshSession, signal: AbortSignal): Promise<string[]> {
    const helpers = Object.entries(HELPERS).map(
      ([name, content]) => `${name}=${Buffer.from(content).toString("base64")}`,
    );
    const result = await this.admin(session, ["bootstrap", ...helpers], signal);
    return result.stdout
      .split("\n")
      .filter((line) => line.startsWith("__LAKEBOX_USER__="))
      .map((line) => line.slice("__LAKEBOX_USER__=".length).trim());
  }

  private async admin(
    session: SshSession,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string }> {
    const encoded = Buffer.from(ADMIN_SCRIPT).toString("base64");
    const result = await session.executePrivileged(
      "sh",
      ["-c", `printf %s '${encoded}' | base64 -d | sh -s -- ${args.map(shellQuote).join(" ")}`],
      { timeoutMs: SETUP_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    ).result;
    if (!result.success) {
      throw new Error(
        `Lakebox ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
      );
    }
    return result;
  }

  /** Marks activity, readies the current boot, and converges the user's account. */
  private async readyUser(
    user: LakeboxUser,
    identity: string,
    signal?: AbortSignal,
  ): Promise<Boot> {
    this.touch();
    const boot = await this.ready(signal);
    await this.convergeUser(boot, user, identity, signal);
    return boot;
  }

  /** Creates or verifies the user's account once per boot. */
  private convergeUser(
    boot: Boot,
    user: LakeboxUser,
    identity: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let converged = boot.users.get(user.hash);
    if (!converged) {
      const digest = createHash("sha256").update(identity.trim().toLowerCase()).digest("hex");
      converged = this.admin(
        boot.session,
        ["ensure-user", user.hash, String(user.uid), digest],
        signal,
      ).then(() => undefined);
      boot.users.set(user.hash, converged);
      converged.catch(() => boot.users.delete(user.hash));
    }
    return converged;
  }

  private async restoreUser(boot: Boot, hash: string): Promise<void> {
    const user = { name: `lakebox-${hash}`, home: `/home/lakebox-${hash}` };
    boot.users.set(hash, Promise.resolve());
    try {
      const result = await boot.session.execute("python3", [CONTROLLER, "start-all"], {
        user,
        timeoutMs: SETUP_TIMEOUT_MS,
        signal: this.shutdownController.signal,
      }).result;
      if (!result.success) throw new Error(result.stderr.trim() || `exit ${result.exitCode}`);
    } catch (error) {
      if (this.shutdownController.signal.aborted) return;
      logger.warn("Lakebox service restore failed", {
        user: hash,
        error: toError(error),
      });
    }
  }

  private async controller(
    boot: Boot,
    user: LakeboxUser,
    command: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const result = await boot.session.execute("python3", [CONTROLLER, command, ...args], {
      user,
      timeoutMs: SETUP_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    }).result;
    if (!result.success) {
      throw new Error(
        `Lakebox service ${command} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
    return JSON.parse(result.stdout) as unknown;
  }

  private async runService(
    boot: Boot,
    user: LakeboxUser,
    definition: LakeboxControllerDefinition,
    signal?: AbortSignal,
  ): Promise<LakeboxService> {
    const key = `${user.hash}\0${definition.name}`;
    const pending = boot.starting.get(key);
    if (pending) return pending;
    const operation = (async () => {
      if (definition.kind === "desktop") {
        boot.desktop ??= this.admin(boot.session, ["desktop-prerequisites"], signal).then(
          () => undefined,
        );
        boot.desktop.catch(() => {
          boot.desktop = undefined;
        });
        await boot.desktop;
      }
      await this.admin(
        boot.session,
        ["allow-port", String(user.uid), String(definition.port)],
        signal,
      );
      const started = LakeboxControllerServiceSchema.parse(
        await this.controller(boot, user, "start", [definition.name], signal),
      );
      this.cacheService(boot, user, started);
      return toLakeboxService(started, user, this.config.routePrefix);
    })().finally(() => boot.starting.delete(key));
    boot.starting.set(key, operation);
    return operation;
  }

  private async refreshServices(
    boot: Boot,
    user: LakeboxUser,
    identity: string,
    signal?: AbortSignal,
  ): Promise<Map<string, LakeboxControllerService>> {
    await this.convergeUser(boot, user, identity, signal);
    const response = (await this.controller(boot, user, "list", [], signal)) as {
      services?: unknown[];
    };
    const services = new Map(
      (response.services ?? []).map((service) => {
        const parsed = LakeboxControllerServiceSchema.parse(service);
        return [parsed.name, parsed] as const;
      }),
    );
    boot.services.set(user.hash, services);
    this.lastServices.set(user.hash, services);
    const observedAt = new Date().toISOString();
    this.lastServicesObservedAt.set(user.hash, observedAt);
    await this.persistServiceSnapshot(boot.entry, user, services, observedAt);
    return services;
  }

  private cacheService(boot: Boot, user: LakeboxUser, service: LakeboxControllerService): void {
    const services = boot.services.get(user.hash) ?? new Map<string, LakeboxControllerService>();
    services.set(service.name, service);
    boot.services.set(user.hash, services);
    this.lastServices.set(user.hash, services);
    const observedAt = new Date().toISOString();
    this.lastServicesObservedAt.set(user.hash, observedAt);
    void this.persistServiceSnapshot(boot.entry, user, services, observedAt);
  }

  private async serviceListing(
    identity: string,
    user: LakeboxUser,
    entry: LakeboxEntry | undefined,
    status: LakeboxStatus,
    signal?: AbortSignal,
  ): Promise<ServiceListing> {
    if (!entry || status === "missing") {
      return { services: this.idleServices(user), stale: false };
    }
    if (status === "running" && this.boot?.key === this.bootKey(entry)) {
      const services = await this.refreshServices(this.boot, user, identity, signal);
      return { services: this.withBuiltIns(user, services), stale: false };
    }
    const memory = this.lastServices.get(user.hash);
    if (memory) {
      const observedAt = this.lastServicesObservedAt.get(user.hash);
      const services =
        status === "running"
          ? memory
          : stoppedSnapshotServices({
              observedAt: observedAt ?? new Date().toISOString(),
              definitions: [...memory.values()].map((service) => service.definition),
            });
      return {
        services: this.withBuiltIns(user, services),
        stale: true,
        ...(observedAt ? { observedAt } : {}),
      };
    }
    const snapshot = await this.serviceSnapshots?.read(entry.sandboxId, user.hash);
    return snapshot
      ? {
          services: this.withBuiltIns(user, stoppedSnapshotServices(snapshot)),
          stale: true,
          observedAt: snapshot.observedAt,
        }
      : { services: this.idleServices(user), stale: true };
  }

  private async persistServiceSnapshot(
    entry: LakeboxEntry,
    user: LakeboxUser,
    services: ReadonlyMap<string, LakeboxControllerService>,
    observedAt: string,
  ): Promise<void> {
    await this.serviceSnapshots?.write(entry.sandboxId, user.hash, {
      observedAt,
      definitions: [...services.values()].map((service) => service.definition),
    });
  }

  private withBuiltIns(
    user: LakeboxUser,
    services: ReadonlyMap<string, LakeboxControllerService>,
  ): LakeboxService[] {
    const builtIns = LAKEBOX_BUILT_IN_SERVICES.map(({ name }) => {
      const saved = services.get(name);
      return saved
        ? toLakeboxService(saved, user, this.config.routePrefix)
        : idleBuiltInService(name, user, this.config.routePrefix);
    });
    const custom = [...services.values()]
      .filter((service) => !LAKEBOX_BUILT_IN_SERVICES.some(({ name }) => name === service.name))
      .map((service) => toLakeboxService(service, user, this.config.routePrefix));
    return [...builtIns, ...custom];
  }

  private idleServices(user: LakeboxUser): LakeboxService[] {
    return LAKEBOX_BUILT_IN_SERVICES.map(({ name }) =>
      idleBuiltInService(name as LakeboxBuiltInServiceName, user, this.config.routePrefix),
    );
  }

  /** Resolves one routed request, waking the Lakebox or service in the background. */
  private async resolveRoute(user: LakeboxUser, name: string): Promise<LakeboxRouteResolution> {
    this.touch();
    const entry = await this.entry();
    const running = entry && normalizeLakeboxStatus(entry.status) === "running";
    const boot = this.boot;
    if (!running || !boot || boot.key !== this.bootKey(entry)) {
      if (!this.config.auto) return { kind: "missing" };
      this.wake(() => this.ready());
      return { kind: "loading" };
    }
    const identity = this.routedIdentities.get(user.hash);
    if (!identity) return { kind: "missing" };
    let service = boot.services.get(user.hash)?.get(name);
    if (!service) service = (await this.refreshServices(boot, user, identity)).get(name);
    const builtIn = lakeboxBuiltInServiceNameSchema.safeParse(name);
    if (!service && !builtIn.success) return { kind: "missing" };
    if (service?.state === "ready") {
      return { kind: "ready", session: boot.session, route: serviceRoute(service.definition) };
    }
    if (service?.state === "error" && !boot.starting.has(`${user.hash}\0${name}`)) {
      return { kind: "failed", message: service.error ?? "the service failed to start" };
    }
    const definition = service?.definition ?? builtInDefinition(builtIn.data!, user);
    this.wake(async () => {
      if (!service) await this.controller(boot, user, "put", [encode(definition)]);
      await this.runService(boot, user, definition);
    });
    return { kind: "loading" };
  }

  private markUnavailable(user: LakeboxUser, name: string): void {
    this.boot?.services.get(user.hash)?.delete(name);
    this.cached = undefined;
  }

  private wake(action: () => Promise<unknown>): void {
    if (this.waking) return;
    this.waking = action()
      .catch((error) => logger.warn("Lakebox wake failed", { error: toError(error) }))
      .finally(() => {
        this.waking = undefined;
      });
  }

  private async readMetrics(signal: AbortSignal): Promise<string> {
    const boot = this.boot;
    if (!boot) throw new Error("Lakebox is not running");
    try {
      return (await this.admin(boot.session, ["metrics"], signal)).stdout;
    } catch (error) {
      this.cached = undefined;
      throw error;
    }
  }

  private leaseMetrics(): void {
    if (!this.boot) return;
    this.metrics.start();
    if (this.metricsLease) clearTimeout(this.metricsLease);
    this.metricsLease = setTimeout(() => {
      if (this.metrics.listenerCount("snapshot") === 0) this.metrics.stop();
    }, METRICS_LEASE_MS);
    this.metricsLease.unref?.();
  }

  /**
   * Releases the SSH session after the idle timeout without commands, service
   * operations, routed traffic, open streams, or metrics watchers. An open
   * session counts as activity for the platform watchdog, so releasing it lets
   * the platform stop the Lakebox after its own idle timeout. The next request
   * reconnects.
   */
  private watchIdle(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      const idleMs = Date.now() - this.lastActivity;
      if (
        !this.boot ||
        this.converging ||
        idleMs < this.config.idleTimeoutSeconds * 1_000 ||
        this.activeCommands > 0 ||
        this.boot.starting.size > 0 ||
        this.routes.activeConnections() > 0 ||
        this.metrics.listenerCount("snapshot") > 0
      ) {
        if (this.routes.activeConnections() > 0 || this.activeCommands > 0) this.touch();
        return;
      }
      logger.info("releasing idle Lakebox session", { idleSeconds: Math.round(idleMs / 1_000) });
      void this.discardBoot();
    }, IDLE_CHECK_MS);
    this.idleTimer.unref?.();
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  private async discardBoot(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    const boot = this.boot;
    this.boot = undefined;
    this.metrics.stop();
    await this.routes.closeBridges();
    await boot?.session.close().catch(() => undefined);
  }
}

function encode(definition: LakeboxControllerDefinition): string {
  return Buffer.from(JSON.stringify(definition)).toString("base64");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Returns whether an error means the managed Lakebox no longer exists. */
export function isLakeboxMissing(error: unknown): boolean {
  return error instanceof LakeboxApiError && error.status === 404;
}
