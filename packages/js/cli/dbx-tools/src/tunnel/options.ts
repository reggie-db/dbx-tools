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

import { configUtils } from "@dbx-tools/core";
import { options as sharedOptions, stringUtils } from "@dbx-tools/shared-core";
import { type AuthGateConfig, frp, interceptor, plugin, portr } from "@dbx-tools/tunnel";
import { z } from "zod";

const text = (description: string) => z.string().trim().min(1).optional().describe(description);
const port = (description: string) =>
  sharedOptions.tcpPortOrZeroSchema.optional().describe(description);
const list = (description: string) =>
  z
    .preprocess(
      (value) => (typeof value === "string" ? stringUtils.parseList(value) : value),
      z.array(z.string().trim().min(1)),
    )
    .optional()
    .describe(description);

export const TunnelOptionsSchema = z
  .object({
    transport: interceptor.TunnelTransportSchema.optional()
      .describe("Public tunnel transport.")
      .meta({ env: "TUNNEL_TRANSPORT" }),
    publicDomain: text("Public tunnel domain.").meta({ env: "TUNNEL_PUBLIC_DOMAIN" }),
    subdomain: text("Portr subdomain."),
    port: port("Public listener port.").meta({
      env: sharedOptions.databricksEnvironmentNames.appPort,
    }),
    appPort: port("Private wrapped application port.").meta({
      env: ["TUNNEL_APP_PORT", "APP_PORT"],
    }),
    allow: list("Email allow-list patterns.").meta({ env: "TUNNEL_AUTH_ALLOW" }),
    subject: text("Verification email subject.").meta({ env: "TUNNEL_AUTH_SUBJECT" }),
    brandName: text("Verification email brand name.").meta({ env: "TUNNEL_AUTH_BRAND_NAME" }),
    message: text("Verification email message.").meta({ env: "TUNNEL_AUTH_MESSAGE" }),
    sessionTtlSeconds: z.coerce
      .number<number>()
      .positive()
      .optional()
      .describe("Session lifetime in seconds.")
      .meta({ env: "TUNNEL_AUTH_SESSION_TTL" }),
    codeTtlSeconds: z.coerce
      .number<number>()
      .positive()
      .optional()
      .describe("One-time-code lifetime in seconds.")
      .meta({ env: "TUNNEL_AUTH_CODE_TTL" }),
    sessionCutoff: text("Invalidate sessions issued before this value.").meta({
      env: "TUNNEL_AUTH_SESSION_CUTOFF",
    }),
    storage: z
      .enum(["auto", "lakebase", "sqlite"])
      .optional()
      .describe("Authentication database mode.")
      .meta({ env: "TUNNEL_AUTH_STORAGE" }),
    sqlitePath: text("Local authentication SQLite file.").meta({
      env: "TUNNEL_AUTH_SQLITE_PATH",
    }),
    forwardHeaders: list("Additional forwarded request header patterns.").meta({
      env: "TUNNEL_FORWARD_HEADERS",
    }),
    gatePaths: list("Additional path prefixes requiring authentication.").meta({
      env: "TUNNEL_GATE_PATHS",
    }),
    bindHosts: list("Interface IPs the gate listens on."),
    insecure: z
      .boolean()
      .optional()
      .describe("Run without an authentication gate.")
      .meta({ env: "TUNNEL_INSECURE" }),
    frpServer: text("FRP control host.").meta({ env: "FRP_SERVER" }),
    frpPublicDomain: text("FRP public HTTP domain.").meta({
      env: "TUNNEL_FRP_PUBLIC_DOMAIN",
    }),
    frpServerPort: port("FRP control port.").meta({ env: "FRP_SERVER_PORT" }),
    frpProtocol: text("FRP transport protocol.").meta({ env: "FRP_PROTOCOL" }),
    frpToken: text("FRP authentication token.").meta({ env: ["FRP_TOKEN", "TUNNEL_TOKEN"] }),
    frpProxyName: text("FRP proxy registration name.").meta({ env: "FRP_PROXY_NAME" }),
  })
  .strict()
  .describe("Public tunnel wrapper command-line options.");

export type TunnelOptions = z.output<typeof TunnelOptionsSchema>;

/** Fully resolved listener, gate, and transport settings used to start a tunnel. */
export interface ResolvedTunnelOptions {
  /** The port the wrapper itself listens on - what portr forwards to. */
  publicPort: number;
  /** The private port the wrapped app is told to bind. Unset means "pick one". */
  appPort?: number;
  /** Interface IPs the gate listens on. Empty means the default (0.0.0.0). */
  bindHosts: string[];
  transport: interceptor.TunnelTransport;
  /**
   * The gate config as the `authGate` PLUGIN takes it - flags only, nothing
   * resolved. Passed straight to the plugin so it applies its own fallbacks
   * exactly once, in the one place that owns them.
   */
  gateConfig: AuthGateConfig;
  /** The same config after the plugin's resolution, for `status` and for routing. */
  gate: plugin.ResolvedAuthGateConfig;
  portr: ReturnType<typeof portr.resolvePortrConfig>;
  frp: ReturnType<typeof frp.resolveFrpConfig>;
}

/** Resolve CLI flag values through the owning tunnel and auth-gate configuration rules. */
export function resolveTunnelOptions(options: TunnelOptions): ResolvedTunnelOptions {
  // The Databricks Apps runtime contract: the platform routes to
  // DATABRICKS_APP_PORT, so the WRAPPER claims it and the wrapped app is moved
  // to a private one.
  const publicPort = configUtils.port(options.port, "DATABRICKS_APP_PORT", 8000);
  const appPort = configUtils.port(options.appPort, "APP_PORT", 0, { prefix: "TUNNEL" });
  const gateConfig: AuthGateConfig = {
    allow: options.allow,
    subject: options.subject,
    brandName: options.brandName,
    message: options.message,
    // Coerced, not resolved: the plugin owns the env name and the default for
    // these, so the flag is passed through as the `config` value it expects and
    // only needs a string -> number nudge on the way.
    sessionTtlSeconds: options.sessionTtlSeconds,
    codeTtlSeconds: options.codeTtlSeconds,
    sessionCutoff: options.sessionCutoff,
    storage: options.storage,
    sqlitePath: options.sqlitePath,
    forwardHeaders: options.forwardHeaders,
    gatePaths: options.gatePaths,
    insecure: options.insecure,
    publicDomain: options.publicDomain,
    publicDomains: options.frpPublicDomain ? [options.frpPublicDomain] : undefined,
  };
  const gate = plugin.resolveAuthGateConfig(gateConfig);
  const transport = interceptor.resolveTunnelTransport(options.transport);
  return {
    publicPort,
    ...(appPort > 0 ? { appPort } : {}),
    bindHosts: options.bindHosts ?? [],
    transport,
    gateConfig,
    gate,
    portr: portr.resolvePortrConfig({
      publicDomain: gate.publicDomain,
      subdomain: options.subdomain,
      port: publicPort,
    }),
    frp: frp.resolveFrpConfig({
      publicDomain: options.frpPublicDomain,
      server: options.frpServer,
      serverPort: options.frpServerPort,
      protocol: options.frpProtocol,
      token: options.frpToken,
      proxyName: options.frpProxyName,
      port: publicPort,
    }),
  };
}
