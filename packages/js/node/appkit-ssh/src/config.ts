import { resolve } from "node:path";
import type { BasePluginConfig } from "@databricks/appkit";
import envPaths from "env-paths";
import { z } from "zod";

const defaultOwnershipPath = resolve(
  envPaths("dbx-tools", { suffix: "" }).data,
  "ssh",
  "machine-assignments.json",
);

export const SshMachineAssignmentSeedSchema = z
  .object({
    userId: z.string().trim().min(1).describe("AppKit user identity assigned to the machine."),
    machineId: z.string().trim().min(1).describe("Existing Databricks Sandbox identifier."),
    workspaceScope: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional workspace id or host restriction for this assignment."),
  })
  .strict()
  .describe("Configured user-to-machine assignment seeded into persistent storage.");

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
    fallbackToSandboxExec: z
      .boolean()
      .default(true)
      .describe("Use the Sandbox execution REST API when the SSH gateway is unreachable."),
    ownershipStorage: z
      .enum(["auto", "lakebase", "disk"])
      .default("auto")
      .describe("Persistent user-to-machine assignment storage backend."),
    ownershipPath: z
      .string()
      .min(1)
      .default(defaultOwnershipPath)
      .describe("Disk fallback path for persistent user-to-machine assignments."),
    machineAssignments: z
      .array(SshMachineAssignmentSeedSchema)
      .default([])
      .describe("Explicit user-to-machine assignments seeded at runtime."),
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
export type SshMachineAssignmentSeed = z.infer<typeof SshMachineAssignmentSeedSchema>;
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
