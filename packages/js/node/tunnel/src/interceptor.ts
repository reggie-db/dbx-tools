/**
 * `tunnelInterceptor()` - the {@link Interceptor} that fronts an app with a public
 * portr and/or frp tunnel, consuming the {@link InterceptorContext} `@dbx-tools/appkit`'s
 * `createApp` hands it.
 *
 * The tunnel runs IN-PROCESS: the APP is the main process and hands this interceptor
 * its context, rather than a wrapper process spawning the app as a child. The
 * interceptor applies the computed workspace host, installs and launches portr on the
 * app's public port, binds the child process to the app, and stops portr during an
 * orderly AppKit shutdown.
 *
 * The passwordless GATE is a separate concern: it is the `authGate` AppKit plugin,
 * which registers the login routes + a gating middleware on the app's own server.
 * Register it in the app's `plugins` for gated traffic. This interceptor is only
 * the portr half - "update the host, bind portr" - the smallest useful unit.
 *
 * @module
 */

import type { Interceptor, InterceptorContext } from "@dbx-tools/appkit";
import { log, object } from "@dbx-tools/shared-core";
import { installFrp, resolveFrpConfig, superviseFrp, writeFrpConfig } from "./frp.ts";
import { startPathProxy } from "./path-proxy.ts";
import { installPortr, resolvePortrConfig, supervisePortr, writePortrConfig } from "./portr.ts";

const logger = log.logger("tunnel:interceptor");

/** Options for {@link tunnelInterceptor} (each also resolvable from env). */
export interface TunnelInterceptorOptions {
  /** Tunnel clients to run. Env `DBX_TOOLS_TUNNEL_TRANSPORT`; defaults to `portr`. */
  transport?: TunnelTransport;
  /** Public host to serve on. Env `TUNNEL_PUBLIC_DOMAIN`. */
  publicDomain?: string;
  /** portr subdomain (else derived from {@link publicDomain}). */
  subdomain?: string;
  /**
   * The PUBLIC port portr forwards to - the port the app itself listens on.
   * Defaults to the Databricks Apps runtime contract `DATABRICKS_APP_PORT`
   * (then `8000`), which is the port the platform routes to.
   */
  port?: number;
  /** frps control host; defaults to the FRP public domain. Env `FRP_SERVER`. */
  frpServer?: string;
  /** FRP public HTTP host. Env `TUNNEL_FRP_PUBLIC_DOMAIN`. */
  frpPublicDomain?: string;
  /** frps control port. Env `FRP_SERVER_PORT`; defaults to `443`. */
  frpServerPort?: number;
  /** frpc transport protocol. Env `FRP_PROTOCOL`; defaults to `wss`. */
  frpProtocol?: string;
  /** frps auth token. Env `FRP_TOKEN` (or `TUNNEL_TOKEN`). */
  frpToken?: string;
  /** frp proxy registration name. Env `FRP_PROXY_NAME`. */
  frpProxyName?: string;
  /** FRP path location. Env `FRP_PATH`; defaults to `DATABRICKS_APP_NAME`. */
  frpPath?: string;
  /** Strip the FRP path before forwarding. Env `FRP_STRIP_PREFIX`; defaults true for non-root paths. */
  frpStripPrefix?: boolean;
}

/** Public tunnel clients supported by the interceptor and CLI. */
export type TunnelTransport = "portr" | "frp" | "both";

interface TunnelAuxiliary {
  stop(): void;
}

interface TunnelRuntime {
  startPortr(config: NonNullable<ReturnType<typeof resolvePortrConfig>>): Promise<TunnelAuxiliary>;
  startFrp(
    config: NonNullable<ReturnType<typeof resolveFrpConfig>>,
    ctx: InterceptorContext,
  ): Promise<TunnelAuxiliary>;
}

const defaultRuntime: TunnelRuntime = {
  async startPortr(config) {
    const portrEnv = await installPortr();
    await writePortrConfig(config, portrEnv);
    return supervisePortr(config, portrEnv);
  },
  async startFrp(config, ctx) {
    const pathProxy =
      config.stripPrefix && config.path !== "/"
        ? await startPathProxy(config.targetPort, config.path)
        : undefined;
    if (pathProxy) {
      config.targetPort = pathProxy.port;
      ctx.onLifecycle("shutdown", () => void pathProxy.close());
    }
    const frpEnv = await installFrp();
    const configPath = await writeFrpConfig(config, frpEnv);
    const supervisor = superviseFrp(config, frpEnv, configPath);
    return {
      stop() {
        supervisor.stop();
        void pathProxy?.close();
      },
    };
  },
};

/** Resolve and validate the tunnel transport selector. */
export function resolveTunnelTransport(transport?: string): TunnelTransport {
  const resolved =
    transport ?? process.env.DBX_TOOLS_TUNNEL_TRANSPORT ?? process.env.TUNNEL_TRANSPORT ?? "portr";
  if (resolved === "portr" || resolved === "frp" || resolved === "both") return resolved;
  throw new TypeError(`invalid tunnel transport: ${resolved} (expected portr, frp, or both)`);
}

/** Resolve the public port portr should target: explicit, else the Apps contract. */
function resolvePublicPort(port?: number): number {
  return port ?? object.toNumber(process.env.DATABRICKS_APP_PORT) ?? 8000;
}

/**
 * Build the tunnel {@link Interceptor}. Pass it to `createApp({ interceptor })`.
 *
 * A no-op (logs and returns) when none of the selected tunnel clients resolve
 * usable configuration, so an app can register it unconditionally.
 *
 * @example
 * import { appkit } from "@dbx-tools/appkit";
 * import { tunnelInterceptor } from "@dbx-tools/tunnel";
 *
 * await appkit.createApp({
 *   plugins: [server({ host, staticPath })],
 *   interceptor: tunnelInterceptor(),
 * });
 */
export function tunnelInterceptor(
  options: TunnelInterceptorOptions = {},
  runtime: TunnelRuntime = defaultRuntime,
): Interceptor {
  return async (ctx: InterceptorContext): Promise<void> => {
    if (ctx.env.databricksHost) {
      process.env.DATABRICKS_HOST ??= ctx.env.databricksHost;
    }

    const port = resolvePublicPort(options.port);
    const transport = resolveTunnelTransport(options.transport);
    const initializers: Array<Promise<TunnelAuxiliary>> = [];
    if (transport === "portr" || transport === "both") {
      const portrConfig = resolvePortrConfig({
        publicDomain: options.publicDomain,
        subdomain: options.subdomain,
        port,
      });
      if (portrConfig) {
        initializers.push(runtime.startPortr(portrConfig));
      } else {
        logger.info("portr not configured (requires PORTR_TOKEN and TUNNEL_PUBLIC_DOMAIN)");
      }
    }
    if (transport === "frp" || transport === "both") {
      const frpConfig = resolveFrpConfig({
        publicDomain: options.frpPublicDomain,
        server: options.frpServer,
        serverPort: options.frpServerPort,
        protocol: options.frpProtocol,
        token: options.frpToken,
        proxyName: options.frpProxyName,
        path: options.frpPath,
        stripPrefix: options.frpStripPrefix,
        port,
      });
      if (frpConfig) {
        initializers.push(runtime.startFrp(frpConfig, ctx));
      } else {
        logger.info("frp not configured (requires TUNNEL_PUBLIC_DOMAIN)");
      }
    }
    if (!initializers.length) return;
    const auxiliaries: TunnelAuxiliary[] = [];
    let stopped = false;
    const stop = () => {
      stopped = true;
      for (const auxiliary of auxiliaries) auxiliary.stop();
    };
    ctx.onTeardown(stop);
    ctx.onLifecycle("shutdown", stop);
    void Promise.allSettled(initializers).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          logger.error("tunnel failed to start", { error: result.reason });
          continue;
        }
        if (stopped) result.value.stop();
        else auxiliaries.push(result.value);
      }
      if (!stopped && auxiliaries.length) logger.info(`tunnel bound: ${transport} -> :${port}`);
    });
    logger.info(`tunnel initialization scheduled: ${transport} -> :${port}`);
  };
}
