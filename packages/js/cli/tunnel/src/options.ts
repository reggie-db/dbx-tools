/**
 * Flag -> config -> default resolution for `dbx tunnel`.
 *
 * The point of this module is that it does almost NOTHING itself: every gate
 * setting is handed straight to `@dbx-tools/tunnel`'s own
 * `plugin.resolveAuthGateConfig`, which is the same function the in-process
 * plugin path calls. The CLI therefore cannot drift from the plugin on a default,
 * an env name, or a coercion rule - a flag is just a value passed where the
 * plugin's `config` object would go, and `config.*` fills the rest in from the
 * environment, a `.env` file, or `databricks.yml`.
 *
 * @module
 */

import type { AuthStorageMode } from "@dbx-tools/auth";
import { config } from "@dbx-tools/core";
import { object } from "@dbx-tools/shared-core";
import { type AuthGateConfig, plugin, portr } from "@dbx-tools/tunnel";

/** Raw commander flag values (every numeric flag arrives as a string). */
export interface TunnelOptions {
  publicDomain?: string;
  subdomain?: string;
  port?: string | number;
  appPort?: string | number;
  allow?: string[];
  subject?: string;
  brandName?: string;
  message?: string;
  sessionTtl?: string | number;
  codeTtl?: string | number;
  sessionCutoff?: string;
  authStorage?: AuthStorageMode;
  authSqlitePath?: string;
  forwardHeaders?: string[];
  gatePath?: string[];
  bind?: string[];
  insecure?: boolean;
}

export interface ResolvedTunnelOptions {
  /** The port the wrapper itself listens on - what portr forwards to. */
  publicPort: number;
  /** The private port the wrapped app is told to bind. Unset means "pick one". */
  appPort?: number;
  /** Interface IPs the gate listens on. Empty means the default (0.0.0.0). */
  bindHosts: string[];
  /**
   * The gate config as the `authGate` PLUGIN takes it - flags only, nothing
   * resolved. Passed straight to the plugin so it applies its own fallbacks
   * exactly once, in the one place that owns them.
   */
  gateConfig: AuthGateConfig;
  /** The same config after the plugin's resolution, for `status` and for routing. */
  gate: plugin.ResolvedAuthGateConfig;
  portr: ReturnType<typeof portr.resolvePortrConfig>;
}

export function resolveTunnelOptions(options: TunnelOptions): ResolvedTunnelOptions {
  // The Databricks Apps runtime contract: the platform routes to
  // DATABRICKS_APP_PORT, so the WRAPPER claims it and the wrapped app is moved
  // to a private one.
  const publicPort = config.port(options.port, "DATABRICKS_APP_PORT", 8000);
  const appPort = config.port(options.appPort, "APP_PORT", 0, { prefix: "TUNNEL" });
  const gateConfig: AuthGateConfig = {
    allow: options.allow,
    subject: options.subject,
    brandName: options.brandName,
    message: options.message,
    // Coerced, not resolved: the plugin owns the env name and the default for
    // these, so the flag is passed through as the `config` value it expects and
    // only needs a string -> number nudge on the way.
    sessionTtlSeconds: object.toNumber(options.sessionTtl),
    codeTtlSeconds: object.toNumber(options.codeTtl),
    sessionCutoff: options.sessionCutoff,
    storage: options.authStorage,
    sqlitePath: options.authSqlitePath,
    forwardHeaders: options.forwardHeaders,
    gatePaths: options.gatePath,
    insecure: options.insecure,
    publicDomain: options.publicDomain,
  };
  const gate = plugin.resolveAuthGateConfig(gateConfig);
  return {
    publicPort,
    ...(appPort > 0 ? { appPort } : {}),
    bindHosts: options.bind ?? [],
    gateConfig,
    gate,
    portr: portr.resolvePortrConfig({
      publicDomain: gate.publicDomain,
      subdomain: options.subdomain,
      port: publicPort,
    }),
  };
}
