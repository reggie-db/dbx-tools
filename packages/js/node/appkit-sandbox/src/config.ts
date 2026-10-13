import type { BasePluginConfig } from "@databricks/appkit";
import { configUtils } from "@dbx-tools/core";
import { z } from "zod";
import { MISE_INSTALL_SCRIPT } from "./_projects.ts";

const SSH_TRANSPORT_CONFIG_KEY = "SANDBOX_SSH_TRANSPORT";
const SSH2_PATCH_CONFIG_KEY = "SANDBOX_SSH_SSH2_PATCH";

const SshTransportSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(["auto", "openssh", "ssh2"]))
  .default("auto");

const Ssh2PatchSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(["auto", "true", "false"]))
  .default("auto");

export const MachineSoftwareSchema = z
  .object({
    name: z.string().min(1).describe("Stable software name used in setup diagnostics."),
    checkCommand: z
      .string()
      .min(1)
      .describe("Idempotent shell condition that succeeds when the software is available."),
    installCommand: z
      .string()
      .min(1)
      .describe("Trusted shell command that installs the software for the Sandbox user."),
  })
  .strict()
  .describe("One configurable user-space software setup step for a Sandbox machine.");

export type MachineSoftware = z.infer<typeof MachineSoftwareSchema>;

const DEFAULT_MACHINE_SOFTWARE: MachineSoftware[] = [
  {
    name: "mise",
    checkCommand:
      'test -x "$HOME/.local/bin/mise" && grep -Fq "# dbx-tools mise path" "$HOME/.profile" && grep -Fq "# dbx-tools mise path" "$HOME/.bashrc" && grep -Fq "# dbx-tools mise path" "$HOME/.zshrc" && ! grep -Fq "# dbx-tools mise activation" "$HOME/.bashrc" && ! grep -Fq "# dbx-tools mise activation" "$HOME/.zshrc"',
    installCommand: MISE_INSTALL_SCRIPT,
  },
];

export const SshPluginConfigSchema = z
  .object({
    auto: z
      .boolean()
      .default(true)
      .describe(
        "Whether commands, services, and routes start a stopped machine before SSH use. Defaults to true; machine creation remains explicit.",
      ),
    fallbackToServicePrincipal: z
      .boolean()
      .default(false)
      .describe(
        "Whether a failed request-scoped OBO REST operation retries with the app service principal. Defaults to false.",
      ),
    sshTransport: SshTransportSchema.describe(
      `SSH transport selection: auto, openssh, or ssh2. Defaults to auto; configure with ${configUtils.name(SSH_TRANSPORT_CONFIG_KEY)}.`,
    ),
    ssh2Patch: Ssh2PatchSchema.describe(
      `ssh2 missing-exec-reply compatibility mode: auto, true, or false. Defaults to auto; configure with ${configUtils.name(SSH2_PATCH_CONFIG_KEY)}.`,
    ),
    sandboxLifetimeSeconds: z
      .number()
      .int()
      .positive()
      .default(86_400)
      .describe(
        "Absolute service-managed Sandbox lifetime in seconds. Defaults to 86400 seconds and is recorded in Lakebase.",
      ),
    reaperIntervalSeconds: z
      .number()
      .int()
      .nonnegative()
      .default(300)
      .describe(
        "Interval between expiration scans in seconds. Defaults to 300 seconds; zero disables scheduled scans.",
      ),
    routePrefix: z
      .string()
      .startsWith("/")
      .default("/sandbox")
      .describe("AppKit root path for remote web routes. Defaults to /sandbox."),
    gatewayPort: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(2222)
      .describe("Databricks Sandbox SSH gateway port. Defaults to 2222."),
    connectTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(30_000)
      .describe("SSH connection timeout in milliseconds. Defaults to 30000."),
    commandTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(120_000)
      .describe("Default remote command timeout in milliseconds. Defaults to 120000."),
    machineSoftware: z
      .array(MachineSoftwareSchema)
      .default(DEFAULT_MACHINE_SOFTWARE)
      .describe(
        "User-space software installed when a running Sandbox is first used. Defaults to mise; pass an empty array to disable setup.",
      ),
    keyDirectory: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional server-side root directory for user-scoped SSH keys, fingerprints, and known-host files.",
      ),
  })
  .strict()
  .describe("Serializable AppKit SSH plugin configuration.");

export type SerializableSshPluginConfig = z.input<typeof SshPluginConfigSchema>;
export type ResolvedSshPluginConfig = z.output<typeof SshPluginConfigSchema>;
/** SSH transport selected for a Sandbox session. */
export type SshTransportMode = ResolvedSshPluginConfig["sshTransport"];
/** Missing exec-reply patch policy applied when ssh2 is selected. */
export type Ssh2PatchMode = ResolvedSshPluginConfig["ssh2Patch"];
/**
 * Configuration accepted by {@link AppKitSshPlugin}.
 *
 * Pass a shared {@link SshRuntime} when the AppKit plugin and Mastra workspace
 * resolver must use the same sessions, routes, ownership store, and reaper.
 */
export type SshPluginConfig = BasePluginConfig &
  SerializableSshPluginConfig & {
    runtime?: import("./runtime.ts").SshRuntime;
  };

/**
 * Resolves serializable defaults and removes AppKit-only fields such as
 * {@link SshPluginConfig.runtime}.
 *
 * @throws A Zod validation error when a field has an invalid type or range.
 */
export function resolveSshPluginConfig(config: SshPluginConfig = {}): ResolvedSshPluginConfig {
  const {
    runtime: _runtime,
    name: _name,
    host: _host,
    context: _context,
    telemetry: _telemetry,
    streamConfig: _stream,
    sshTransport,
    ssh2Patch,
    ...serializable
  } = config;
  return SshPluginConfigSchema.parse({
    ...serializable,
    sshTransport: configUtils.string(sshTransport, SSH_TRANSPORT_CONFIG_KEY),
    ssh2Patch: configUtils.string(ssh2Patch, SSH2_PATCH_CONFIG_KEY),
  });
}
