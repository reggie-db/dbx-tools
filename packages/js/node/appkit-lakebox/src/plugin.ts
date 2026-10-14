import type { IncomingHttpHeaders, IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import {
  createWorkspaceClient,
  lakebase,
  toPlugin,
  type IAppRouter,
  type PluginManifest,
} from "@databricks/appkit";
import {
  executeFromRegistry,
  type ToolkitEntry,
  type ToolkitOptions,
  type ToolRegistry,
} from "@databricks/appkit/beta";
import {
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
  createLakeboxServiceOperationSchema,
  executeLakeboxCommandOperationSchema,
  getLakeboxOperationSchema,
  getLakeboxServiceLogsOperationSchema,
  LAKEBOX_PLUGIN_NAME,
  LAKEBOX_ROUTES,
  lakeboxCommandRequestSchema,
  lakeboxServiceActionSchema,
  lakeboxServiceLogsRequestSchema,
  listLakeboxServicesOperationSchema,
  removeLakeboxServiceOperationSchema,
  startLakeboxOperationSchema,
  startLakeboxServiceOperationSchema,
  stopLakeboxOperationSchema,
  stopLakeboxServiceOperationSchema,
  type CreateLakeboxServiceRequest,
  type LakeboxClientConfigInput,
  type LakeboxCommandRequest,
  type LakeboxServiceLogsRequest,
} from "@dbx-tools/shared-lakebox";
import type { Application, Request, Response } from "express";
import type { JSONSchema7 } from "json-schema";
import { z } from "zod";
import {
  LakeboxPluginConfigSchema,
  resolveLakeboxPluginConfig,
  type LakeboxPluginConfig,
} from "./config.ts";
import { LakeboxRuntime, type LakeboxLegacyPool } from "./runtime.ts";

interface ServerExtension {
  addExtension(fn: (application: Application) => void): void;
  getServer(): HttpServer;
}

interface UpgradeIdentityGate {
  isProtectedHost(headers: Headers): boolean;
  session(headers: Headers): Promise<string | undefined>;
}

const CONFIG_SCHEMA = z.toJSONSchema(LakeboxPluginConfigSchema) as JSONSchema7;

/**
 * AppKit plugin for the single app Lakebox.
 *
 * Registers user-scoped REST routes, agent tools, the deterministic service
 * proxy, and WebSocket upgrade handling. Every Lakebox lifecycle call uses the
 * app service principal; the authenticated request identity only selects the
 * user's Lakebox account and authorizes that user's routes.
 */
export class AppKitLakeboxPlugin extends ToolRegistryPlugin<LakeboxPluginConfig> {
  static manifest = {
    name: LAKEBOX_PLUGIN_NAME,
    displayName: "Lakebox",
    description:
      "Runs per-user services, terminals, desktops, and commands in one lazily created Databricks Lakebox.",
    stability: "beta",
    resources: { required: [], optional: [] },
    config: { schema: CONFIG_SCHEMA },
  } satisfies PluginManifest<typeof LAKEBOX_PLUGIN_NAME>;

  readonly runtime: LakeboxRuntime;
  private mounted = false;
  private httpServer?: HttpServer;
  private upgradeAttachTimer?: ReturnType<typeof setTimeout>;
  private upgradeIdentityGate?: UpgradeIdentityGate;
  private readonly upgradeHandler = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    void this.handleUpgrade(request, socket, head);
  };

  /** Creates a plugin with a supplied shared runtime or one from resolved config. */
  constructor(config: LakeboxPluginConfig = {}) {
    super(config);
    this.runtime = config.runtime ?? new LakeboxRuntime(resolveLakeboxPluginConfig(config));
  }

  protected get toolRegistry(): ToolRegistry {
    return this.createToolRegistry();
  }

  override async setup(): Promise<void> {
    this.context?.onLifecycle("setup:complete", async () => {
      this.runtime.initialize(createWorkspaceClient().config, (headers) =>
        this.requestIdentity(headers),
      );
      const pool = pluginRegistry.instance(this.context, lakebase)?.exports().pool;
      void this.runtime.cleanupLegacy(
        pool
          ? (lakebaseResolver.captureServicePrincipalPool(pool) as LakeboxLegacyPool)
          : undefined,
      );
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
    const json = (
      name: string,
      method: "get" | "post" | "delete",
      path: string,
      handler: (identity: string, req: Request) => Promise<unknown>,
    ) =>
      this.route(router, {
        name,
        method,
        path,
        handler: async (req, res) => {
          res.json(await handler(this.resolveUserId(req), req));
        },
      });
    json("status", "get", LAKEBOX_ROUTES.status, (identity) => this.runtime.summary(identity));
    json("start", "post", LAKEBOX_ROUTES.start, async (identity) => {
      await this.runtime.start();
      return this.runtime.summary(identity);
    });
    json("stop", "post", LAKEBOX_ROUTES.stop, async (identity) => {
      await this.runtime.stop();
      return this.runtime.summary(identity);
    });
    json(
      "executeCommand",
      "post",
      LAKEBOX_ROUTES.commands,
      (identity, req) =>
        this.runtime.execute(identity, lakeboxCommandRequestSchema.parse(req.body ?? {})).result,
    );
    json("services", "get", LAKEBOX_ROUTES.services, async (identity) => ({
      services: await this.runtime.listServices(identity),
    }));
    json("createService", "post", LAKEBOX_ROUTES.services, async (identity, req) => ({
      service: await this.runtime.createService(identity, req.body ?? {}),
    }));
    json("startService", "post", LAKEBOX_ROUTES.serviceStart, async (identity, req) => ({
      service: await this.runtime.startService(identity, serviceName(req)),
    }));
    json("stopService", "post", LAKEBOX_ROUTES.serviceStop, async (identity, req) => ({
      service: await this.runtime.stopService(identity, serviceName(req)),
    }));
    json("removeService", "delete", LAKEBOX_ROUTES.service, async (identity, req) => ({
      removed: await this.runtime.removeService(identity, serviceName(req)),
    }));
    json("serviceLogs", "get", LAKEBOX_ROUTES.serviceLogs, (identity, req) =>
      this.runtime.serviceLogs(
        identity,
        lakeboxServiceLogsRequestSchema.parse({
          name: req.params.name,
          maxLines: req.query.maxLines,
          maxChars: req.query.maxChars,
        }),
      ),
    );
    json("metrics", "get", LAKEBOX_ROUTES.metrics, () => this.runtime.metricsResponse());
    this.route(router, {
      name: "metricsStream",
      method: "get",
      path: LAKEBOX_ROUTES.metricsStream,
      handler: async (req, res) => this.streamMetrics(req, res),
    });
  }

  /** Returns browser-safe route defaults published through AppKit client config. */
  clientConfig(): LakeboxClientConfigInput {
    return { routePrefix: this.runtime.config.routePrefix };
  }

  /** Returns selected AppKit toolkit entries backed by this plugin's agent tools. */
  toolkit(options?: ToolkitOptions): Record<string, ToolkitEntry> {
    return toolkitEntries.entries(LAKEBOX_PLUGIN_NAME, this.getAgentTools(), options);
  }

  /** Executes one registered agent tool for the current execution identity. */
  override executeAgentTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    context?: AgentToolExecutionContext,
  ): Promise<unknown> {
    return executeFromRegistry(this.createToolRegistry(context?.resourceId), name, args, signal);
  }

  /** Returns the typed sibling-plugin API. */
  exports() {
    return {
      summary: (identity: string) => this.runtime.summary(identity),
      start: () => this.runtime.start(),
      stop: () => this.runtime.stop(),
      delete: () => this.runtime.delete(),
      executeCommand: (identity: string, input: LakeboxCommandRequest) =>
        this.runtime.execute(identity, input).result,
      listServices: (identity: string) => this.runtime.listServices(identity),
      createService: (identity: string, input: CreateLakeboxServiceRequest) =>
        this.runtime.createService(identity, input),
      startService: (identity: string, name: string) => this.runtime.startService(identity, name),
      stopService: (identity: string, name: string) => this.runtime.stopService(identity, name),
      removeService: (identity: string, name: string) => this.runtime.removeService(identity, name),
      serviceLogs: (identity: string, input: LakeboxServiceLogsRequest) =>
        this.runtime.serviceLogs(identity, input),
      operations: (identity?: string) => this.operations(identity),
      toolkit: (options?: ToolkitOptions) => this.toolkit(options),
    };
  }

  /** Cancels in-flight work before shutdown tears down resources. */
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

  /** Returns the Zod-owned operation contracts used by agent tools. */
  operations(identity?: string) {
    const user = () => identity ?? this.executionIdentity();
    return toolOperations.defineOperations({
      get_lakebox: {
        schema: getLakeboxOperationSchema,
        execute: async (_input, signal) => withoutLogs(await this.runtime.summary(user(), signal)),
      },
      start_lakebox: {
        schema: startLakeboxOperationSchema,
        execute: async (_input, signal) => {
          await this.runtime.start(signal);
          return withoutLogs(await this.runtime.summary(user(), signal));
        },
      },
      stop_lakebox: {
        schema: stopLakeboxOperationSchema,
        execute: async (_input, signal) => {
          await this.runtime.stop(signal);
          return withoutLogs(await this.runtime.summary(user(), signal));
        },
      },
      execute_lakebox_command: {
        schema: executeLakeboxCommandOperationSchema,
        execute: (input, signal) => this.runtime.execute(user(), input, signal).result,
      },
      list_lakebox_services: {
        schema: listLakeboxServicesOperationSchema,
        execute: async (_input, signal) => ({
          services: (await this.runtime.listServices(user(), signal)).map(omitLog),
        }),
      },
      create_lakebox_service: {
        schema: createLakeboxServiceOperationSchema,
        execute: async (input, signal) => ({
          service: omitLog(await this.runtime.createService(user(), input, signal)),
        }),
      },
      start_lakebox_service: {
        schema: startLakeboxServiceOperationSchema,
        execute: async (input, signal) => ({
          service: omitLog(await this.runtime.startService(user(), input.name, signal)),
        }),
      },
      stop_lakebox_service: {
        schema: stopLakeboxServiceOperationSchema,
        execute: async (input, signal) => ({
          service: omitLog(await this.runtime.stopService(user(), input.name, signal)),
        }),
      },
      remove_lakebox_service: {
        schema: removeLakeboxServiceOperationSchema,
        execute: async (input, signal) => ({
          removed: await this.runtime.removeService(user(), input.name, signal),
        }),
      },
      get_lakebox_service_logs: {
        schema: getLakeboxServiceLogsOperationSchema,
        execute: (input, signal) => this.runtime.serviceLogs(user(), input, signal),
      },
    });
  }

  private createToolRegistry(identity?: string): ToolRegistry {
    return toolOperations.toolRegistryFromOperations(this.operations(identity));
  }

  private executionIdentity(): string {
    const context = appkit.tryGetExecutionContext();
    if (!context) throw new Error("Lakebox tools require an AppKit execution context");
    return "userId" in context ? context.userId : context.serviceUserId;
  }

  /**
   * Resolves route identity with the same rules as REST: the forwarded user,
   * or AppKit's development user for direct loopback navigation outside
   * production. Everything else is anonymous and fails closed.
   */
  private requestIdentity(headers: IncomingHttpHeaders): string | undefined {
    const forwarded = headerValue(headers[USER_ID_HEADER])?.trim();
    if (forwarded) return forwarded;
    if (process.env.NODE_ENV !== "development" || !isLoopbackHost(headerValue(headers.host))) {
      return undefined;
    }
    try {
      return this.resolveUserId({
        header: (name: string) => headerValue(headers[name.toLowerCase()]),
      } as unknown as Request);
    } catch {
      return undefined;
    }
  }

  private async streamMetrics(req: Request, res: Response): Promise<void> {
    const initial = await this.runtime.metricsResponse();
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify(initial)}\n\n`);
    const unsubscribe = this.runtime.subscribeMetrics((snapshot) => {
      res.write(`data: ${JSON.stringify({ status: "running", series: [snapshot] })}\n\n`);
    });
    req.once("close", unsubscribe);
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
}

function serviceName(req: Request): string {
  return lakeboxServiceActionSchema.parse({ name: req.params.name }).name;
}

function omitLog<T extends { log?: string }>({ log: _log, ...value }: T): Omit<T, "log"> {
  return value;
}

function withoutLogs<T extends { services: Array<{ log?: string }> }>(summary: T): T {
  return { ...summary, services: summary.services.map(omitLog) };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
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

/** AppKit plugin factory for {@link AppKitLakeboxPlugin}. */
export const lakebox = toPlugin(AppKitLakeboxPlugin);
