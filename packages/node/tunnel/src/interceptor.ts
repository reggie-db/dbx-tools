/**
 * `tunnelInterceptor()` - the {@link Interceptor} that fronts an app with a public
 * portr tunnel, consuming the {@link InterceptorContext} `@dbx-tools/appkit`'s
 * `createApp` hands it.
 *
 * This is the in-process replacement for the old `dbxt-tunnel -- <cmd>` wrapper.
 * Instead of the tunnel being the main process that spawns the app as a child, the
 * APP is the main process and hands this interceptor its context. The interceptor:
 *
 *   1. applies the workspace host the context computed to `process.env`
 *      (`DATABRICKS_HOST`), so portr and any later SDK call agree on the workspace;
 *   2. installs + launches portr, pointed at the app's PUBLIC port;
 *   3. `bindProcess`es portr so the app and the tunnel live and die as one -
 *      signals pass through and either death tears the pair down (the
 *      concurrently-style supervision that used to be `superviseExit`);
 *   4. registers an AppKit `shutdown` lifecycle handler so an orderly app shutdown
 *      also stops portr.
 *
 * The email-OTP GATE is a separate concern: it is the {@link authGate} AppKit
 * plugin plus the {@link startProxy} reverse-proxy, both exported from this package
 * for an app that wants to gate the tunnelled traffic. This interceptor is only the
 * portr half - "update the host, bind portr" - matching the smallest useful unit.
 *
 * @module
 */

import type { Interceptor, InterceptorContext } from "@dbx-tools/appkit";
import { log } from "@dbx-tools/shared-core";
import { installPortr, resolvePortrConfig, startPortr, writePortrConfig } from "./portr.ts";

const logger = log.logger("tunnel:interceptor");

/** Options for {@link tunnelInterceptor} (each also resolvable from env). */
export interface TunnelInterceptorOptions {
  /** portr `<subdomain>.<server>` to serve on. Env `TUNNEL_PUBLIC_DOMAIN`. */
  publicDomain?: string;
  /** portr subdomain (else derived from {@link publicDomain}). */
  subdomain?: string;
  /**
   * The PUBLIC port portr forwards to - the port the app itself listens on.
   * Defaults to the Databricks Apps runtime contract `DATABRICKS_APP_PORT`
   * (then `8000`), which is the port the platform routes to.
   */
  port?: number;
}

/** Resolve the public port portr should target: explicit, else the Apps contract. */
function resolvePublicPort(port?: number): number {
  return port ?? Number(process.env.DATABRICKS_APP_PORT ?? 8000);
}

/**
 * Build the tunnel {@link Interceptor}. Pass it to `createApp({ interceptor })`.
 *
 * A no-op (logs and returns) when no portr tunnel is configured - no `PORTR_TOKEN`
 * or no resolvable `<subdomain>.<server>` - so an app can register it
 * unconditionally and only actually tunnels where the deployment wired portr.
 *
 * @example
 * import { createApp } from "@dbx-tools/appkit";
 * import { tunnelInterceptor } from "@dbx-tools/tunnel";
 *
 * await createApp({
 *   plugins: [server({ host, staticPath })],
 *   interceptor: tunnelInterceptor(),
 * });
 */
export function tunnelInterceptor(options: TunnelInterceptorOptions = {}): Interceptor {
  return (ctx: InterceptorContext): void => {
    // 1. Apply the computed workspace host so portr + the SDK agree. The context
    //    already resolved it (from the env / auto-config); set it only when it is
    //    known and not already present, so an explicit env wins.
    if (ctx.env.databricksHost) {
      process.env.DATABRICKS_HOST ??= ctx.env.databricksHost;
    }

    // 2. Resolve portr wiring. No token / domain -> no tunnel; leave the app alone.
    //    `resolvePortrConfig` already falls back to TUNNEL_PUBLIC_DOMAIN itself, so
    //    the explicit option is passed straight through.
    const port = resolvePublicPort(options.port);
    const portrConfig = resolvePortrConfig({
      publicDomain: options.publicDomain,
      subdomain: options.subdomain,
      port,
    });
    if (!portrConfig) {
      logger.info("no PORTR_TOKEN/TUNNEL_PUBLIC_DOMAIN - the app runs without a public tunnel");
      return;
    }

    // 3. Install + launch portr, then bind it: the app and portr now share a fate.
    const portrEnv = installPortr();
    writePortrConfig(portrConfig, portrEnv);
    const portr = startPortr(portrConfig, portrEnv);
    ctx.bindProcess(portr);

    // 4. An orderly AppKit shutdown also stops portr (belt-and-suspenders with the
    //    signal pass-through `bindProcess` already installed).
    ctx.onLifecycle("shutdown", () => {
      if (!portr.killed) portr.kill("SIGTERM");
    });

    logger.info(`tunnel bound: portr -> :${port} (${portrConfig.subdomain}.${portrConfig.server})`);
  };
}
