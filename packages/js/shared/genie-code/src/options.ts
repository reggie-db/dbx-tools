/**
 * Browser-safe configuration for the managed Genie Code CLI.
 *
 * @module
 */

import { options, stringUtils } from "@dbx-tools/shared-core";
import { ChatModelSelectionOptionsSchema } from "@dbx-tools/shared-model-gateway/options";
import { z } from "zod";

/** Pinned Genie Code release installed by the managed CLI. */
export const GENIE_CODE_VERSION = "0.1.0-beta.2";

export const GenieCodeOptionsSchema = ChatModelSelectionOptionsSchema.safeExtend({
  profile: options.DatabricksOptionsSchema.shape.profile.describe(
    "Databricks profile used by the model-gateway sidecar.",
  ),
  gatewayListen: options
    .listenAddressSchema({ host: "127.0.0.1", port: 0, loopback: true })
    .describe("Loopback listener allocated for the model-gateway sidecar."),
})
  .strict()
  .describe("Managed Genie Code runtime options.");

export const GenieCodeHomeSchema = z
  .object({
    profile: options.DatabricksOptionsSchema.shape.profile.unwrap(),
    digest: z
      .string()
      .regex(/^[0-9a-f]{12}$/)
      .describe("First twelve lowercase hexadecimal characters of the exact profile SHA-256."),
  })
  .strict()
  .describe("Inputs used to derive one profile-scoped Genie home.");

export const GenieCodeRunnerOptionsSchema = z
  .object({
    executable: z.string().trim().min(1).describe("Installed Genie Code executable."),
    arguments: z.array(z.string()).readonly().describe("Arguments forwarded to Genie Code."),
    home: z.string().trim().min(1).describe("Profile-specific GENIE_HOME."),
    gatewayHealthUrl: z.url().describe("Guarded model-gateway health URL."),
    bearerToken: z.string().min(1).describe("Ephemeral model-gateway bearer token."),
    startupTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(60_000)
      .describe("Maximum milliseconds to wait for the gateway."),
  })
  .strict()
  .describe("Serialized options passed to the internal Genie child runner.");

export type GenieCodeOptions = z.input<typeof GenieCodeOptionsSchema>;

export type ResolvedGenieCodeOptions = z.output<typeof GenieCodeOptionsSchema>;

export type GenieCodeHome = z.input<typeof GenieCodeHomeSchema>;

export type GenieCodeRunnerOptions = z.input<typeof GenieCodeRunnerOptionsSchema>;

/** Defaults derived from the owning managed Genie Code schema. */
export const GENIE_CODE_DEFAULTS = Object.freeze(GenieCodeOptionsSchema.parse({}));

/** Validate and default managed Genie Code options. */
export function resolveGenieCodeOptions(value: GenieCodeOptions = {}): ResolvedGenieCodeOptions {
  return GenieCodeOptionsSchema.parse(value);
}

/** Build the readable directory name for one exact Databricks profile. */
export function genieCodeHomeName(value: GenieCodeHome): string {
  const home = GenieCodeHomeSchema.parse(value);
  const profile = stringUtils.toSlugWithOptions(
    { maxLength: 40, truncateStrategy: "trim" },
    home.profile,
  );
  return `${profile}-${home.digest}`;
}
