import { basename } from "node:path";
import type { BasePluginConfig } from "@databricks/appkit";
import { boolean, configUtils, string, ENV_ONLY, positiveInt, root } from "@dbx-tools/core";
import { Ssh2PatchModeSchema, SshTransportModeSchema } from "@dbx-tools/lakebox";
import { LAKEBOX_DEFAULT_ROUTE_PREFIX } from "@dbx-tools/shared-lakebox";
import { z } from "zod";

const APPLICATION_CONFIG_KEY = "LAKEBOX_APPLICATION";
const IDLE_TIMEOUT_CONFIG_KEY = "LAKEBOX_IDLE_TIMEOUT_SECONDS";
const DESTROY_AFTER_STARTUP_FAILURE_CONFIG_KEY = "LAKEBOX_DESTROY_AFTER_STARTUP_FAILURE_SECONDS";
const SSH_TRANSPORT_CONFIG_KEY = "LAKEBOX_SSH_TRANSPORT";
const SSH2_PATCH_CONFIG_KEY = "LAKEBOX_SSH_SSH2_PATCH";

/** Resolve an optional destructive startup-recovery timeout. */
function _destroyAfterStartupFailureSeconds(configured: unknown): false | number | undefined {
  if (boolean(configured, DESTROY_AFTER_STARTUP_FAILURE_CONFIG_KEY) === false) return false;
  const seconds = positiveInt(configured, DESTROY_AFTER_STARTUP_FAILURE_CONFIG_KEY, 0);
  return seconds > 0 ? seconds : undefined;
}

export const LakeboxPluginConfigSchema = z
  .object({
    auto: z
      .boolean()
      .default(true)
      .describe(
        "Whether commands, services, and routes create or start the app Lakebox on demand. Defaults to true.",
      ),
    application: z
      .string()
      .trim()
      .min(1)
      .describe(
        `Stable application key for the persisted Lakebox resource ID. Defaults to ${configUtils.name(APPLICATION_CONFIG_KEY)}, then DATABRICKS_APP_NAME, then the project directory name.`,
      ),
    idleTimeoutSeconds: z
      .number()
      .int()
      .min(60)
      .max(86_400)
      .default(3_600)
      .describe(
        `Platform idle timeout that stops the Lakebox after inactivity, from 60 to 86400 seconds. Defaults to 3600; configure with ${configUtils.name(IDLE_TIMEOUT_CONFIG_KEY)}.`,
      ),
    routePrefix: z
      .string()
      .startsWith("/")
      .default(LAKEBOX_DEFAULT_ROUTE_PREFIX)
      .describe("AppKit root path for user service routes. Defaults to /lakebox."),
    gatewayPort: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(2222)
      .describe("Lakebox SSH gateway port. Defaults to 2222."),
    connectTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(30_000)
      .describe("SSH connection timeout in milliseconds. Defaults to 30000."),
    destroyAfterStartupFailureSeconds: z
      .union([z.literal(false), z.number().int().min(5).max(600)])
      .default(false)
      .describe(
        `Destroy and recreate the Lakebox when its SSH gateway remains unreachable for this many seconds, from 5 to 600. Defaults to false; configure with ${configUtils.name(DESTROY_AFTER_STARTUP_FAILURE_CONFIG_KEY)}.`,
      ),
    commandTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(120_000)
      .describe("Default command timeout in milliseconds. Defaults to 120000."),
    metricsIntervalSeconds: z
      .number()
      .int()
      .min(1)
      .max(300)
      .default(5)
      .describe("Interval between metrics samples while the Lakebox runs. Defaults to 5."),
    sshTransport: SshTransportModeSchema.describe(
      `SSH transport: auto, openssh, or ssh2. Configure with ${configUtils.name(SSH_TRANSPORT_CONFIG_KEY)}.`,
    ),
    ssh2Patch: Ssh2PatchModeSchema.describe(
      `ssh2 missing-exec-reply workaround: auto, true, or false. Configure with ${configUtils.name(SSH2_PATCH_CONFIG_KEY)}.`,
    ),
    keyDirectory: z
      .string()
      .min(1)
      .optional()
      .describe("Server-side directory for the app SSH key and gateway host keys."),
  })
  .strict()
  .describe("Serializable Lakebox AppKit plugin configuration.");

export type SerializableLakeboxPluginConfig = z.input<typeof LakeboxPluginConfigSchema>;
export type ResolvedLakeboxPluginConfig = z.output<typeof LakeboxPluginConfigSchema>;

/**
 * Configuration accepted by the Lakebox AppKit plugin.
 *
 * Pass a shared runtime when the plugin and the Mastra workspace resolver must
 * use the same sessions, routes, and metrics.
 */
export type LakeboxPluginConfig = BasePluginConfig &
  Partial<SerializableLakeboxPluginConfig> & {
    runtime?: import("./runtime.ts").LakeboxRuntime;
  };

/**
 * Resolves defaults through configUtils and removes AppKit-only fields.
 *
 * @throws A Zod validation error when a field has an invalid type or range.
 */
export function resolveLakeboxPluginConfig(
  config: LakeboxPluginConfig = {},
): ResolvedLakeboxPluginConfig {
  const {
    runtime: _runtime,
    name: _name,
    host: _host,
    context: _context,
    telemetry: _telemetry,
    streamConfig: _stream,
    application,
    idleTimeoutSeconds,
    destroyAfterStartupFailureSeconds,
    sshTransport,
    ssh2Patch,
    ...serializable
  } = config;
  return LakeboxPluginConfigSchema.parse({
    ...serializable,
    application:
      string(application, APPLICATION_CONFIG_KEY) ??
      string(undefined, "DATABRICKS_APP_NAME", ENV_ONLY) ??
      basename(root() ?? process.cwd()),
    idleTimeoutSeconds: positiveInt(idleTimeoutSeconds, IDLE_TIMEOUT_CONFIG_KEY, 3_600),
    destroyAfterStartupFailureSeconds: _destroyAfterStartupFailureSeconds(
      destroyAfterStartupFailureSeconds,
    ),
    sshTransport: string(sshTransport, SSH_TRANSPORT_CONFIG_KEY),
    ssh2Patch: string(ssh2Patch, SSH2_PATCH_CONFIG_KEY),
  });
}
