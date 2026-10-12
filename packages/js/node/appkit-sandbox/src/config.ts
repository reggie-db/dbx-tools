import type { BasePluginConfig } from "@databricks/appkit";
import { z } from "zod";

export const SshPluginConfigSchema = z
  .object({
    auto: z
      .boolean()
      .default(true)
      .describe("Automatically start stopped machines before SSH use."),
    fallbackToServicePrincipal: z
      .boolean()
      .default(false)
      .describe("Retry failed request-scoped OBO calls as the app service principal."),
    sandboxLifetimeSeconds: z
      .number()
      .int()
      .positive()
      .default(86_400)
      .describe("Lifetime encoded into each service-managed Sandbox name."),
    reaperIntervalSeconds: z
      .number()
      .int()
      .nonnegative()
      .default(300)
      .describe("Interval between expiration scans; zero disables scheduled scans."),
    routePrefix: z
      .string()
      .startsWith("/")
      .default("/sandbox")
      .describe("Root path for remote web routes."),
    defaultRemotePort: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(3000)
      .describe("Default remote web port."),
    gatewayPort: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(2222)
      .describe("Databricks Sandbox SSH gateway port."),
    connectTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(30_000)
      .describe("SSH connection timeout."),
    commandTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(120_000)
      .describe("Default remote command timeout."),
    keyDirectory: z
      .string()
      .min(1)
      .optional()
      .describe("Server-side directory for user-scoped SSH keys."),
  })
  .strict()
  .describe("Serializable AppKit SSH plugin configuration.");

export type SerializableSshPluginConfig = z.input<typeof SshPluginConfigSchema>;
export type ResolvedSshPluginConfig = z.output<typeof SshPluginConfigSchema>;
/** Configuration accepted by the AppKit SSH plugin. */
export type SshPluginConfig = BasePluginConfig &
  SerializableSshPluginConfig & {
    runtime?: import("./runtime.ts").SshRuntime;
  };

/** Resolves serializable SSH plugin defaults and removes AppKit-only fields. */
export function resolveSshPluginConfig(config: SshPluginConfig = {}): ResolvedSshPluginConfig {
  const {
    runtime: _runtime,
    name: _name,
    host: _host,
    context: _context,
    telemetry: _telemetry,
    streamConfig: _stream,
    ...serializable
  } = config;
  return SshPluginConfigSchema.parse(serializable);
}
