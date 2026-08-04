/**
 * `tunnelInterceptor()` - the {@link Interceptor} that fronts an app with a public
 * portr tunnel, consuming the {@link InterceptorContext} `@dbx-tools/appkit`'s
 * `createApp` hands it.
 *
 * This is the in-process replacement for the old `dbxt-tunnel -- <cmd>` wrapper.
 * Instead of the tunnel being the main process that spawns the app as a child, the
 * APP is the main process and hands this interceptor its context. The interceptor
 * applies the computed workspace host, installs and launches portr on the app's
 * public port, binds the child process to the app, and stops portr during an
 * orderly AppKit shutdown.
 *
 * The email-OTP GATE is a separate concern: it is the `authGate` AppKit plugin,
 * which registers the login routes + a gating middleware on the app's own server.
 * Register it in the app's `plugins` for gated traffic. This interceptor is only
 * the portr half - "update the host, bind portr" - the smallest useful unit.
 *
 * @module
 */

import type { Interceptor, InterceptorContext } from "@dbx-tools/appkit";
import { log, object } from "@dbx-tools/shared-core";
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
  return port ?? object.toNumber(process.env.DATABRICKS_APP_PORT) ?? 8000;
}

/**
 * Build the tunnel {@link Interceptor}. Pass it to `createApp({ interceptor })`.
 *
 * A no-op (logs and returns) when no portr tunnel is configured - no `PORTR_TOKEN`
 * or no resolvable `<subdomain>.<server>` - so an app can register it
 * unconditionally and only actually tunnels where the deployment wired portr.
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
export function tunnelInterceptor(options: TunnelInterceptorOptions = {}): Interceptor {
  return async (ctx: InterceptorContext): Promise<void> => {
    if (ctx.env.databricksHost) {
      process.env.DATABRICKS_HOST ??= ctx.env.databricksHost;
    }

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

    const portrEnv = await installPortr();
    await writePortrConfig(portrConfig, portrEnv);
    const portr = await startPortr(portrConfig, portrEnv);
    ctx.bindProcess(portr);

    ctx.onLifecycle("shutdown", () => {
      if (!portr.killed) portr.kill("SIGTERM");
    });

    logger.info(`tunnel bound: portr -> :${port} (${portrConfig.subdomain}.${portrConfig.server})`);
  };
}
