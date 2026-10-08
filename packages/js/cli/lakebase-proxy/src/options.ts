/**
 * Lakebase proxy listener, service, and URL command options.
 *
 * @module
 */

import { options } from "@dbx-tools/shared-core";
import { z } from "zod";

const text = (description: string) => z.string().trim().min(1).optional().describe(description);

export const LakebaseProxyOptionsSchema = z
  .object({
    ...options.PostgresOptionsSchema.shape,
    listen: options
      .listenAddressSchema({ port: 5432, loopback: true })
      .describe("Loopback listener address."),
    startupTimeoutSeconds: z.coerce
      .number<number>()
      .int()
      .nonnegative()
      .default(30)
      .describe("Startup timeout in seconds."),
    profile: options.DatabricksOptionsSchema.shape.profile.describe("Exact Databricks profile."),
  })
  .strict()
  .describe("Lakebase proxy listener and service options.");

export const LakebaseProxyUrlOptionsSchema = z
  .object({
    target: text("Lakebase project, resource path, host, or URL."),
    lakebaseEndpoint: options.LakebaseOptionsSchema.shape.lakebaseEndpoint,
    listen: options.listenAddressSchema({ port: 5432 }).describe("Local proxy address."),
  })
  .strict()
  .refine(
    (configured) => configured.target !== undefined || configured.lakebaseEndpoint !== undefined,
    {
      message: "URL requires target or endpoint.",
      path: ["target"],
    },
  )
  .describe("Options for formatting a local Lakebase PostgreSQL URL.");

export type LakebaseProxyOptions = z.input<typeof LakebaseProxyOptionsSchema>;

export type ResolvedLakebaseProxyOptions = z.output<typeof LakebaseProxyOptionsSchema>;

export type LakebaseProxyUrlOptions = z.output<typeof LakebaseProxyUrlOptionsSchema>;

/** Validate and default Lakebase proxy listener options. */
export function resolveLakebaseProxyOptions(
  options: LakebaseProxyOptions = {},
): ResolvedLakebaseProxyOptions {
  return LakebaseProxyOptionsSchema.parse(options);
}
