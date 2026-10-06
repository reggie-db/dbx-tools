/**
 * Foreground FalkorDB CLI configuration.
 *
 * @module
 */

import { options } from "@dbx-tools/shared-core";
import { z } from "zod";

const text = (description: string) => z.string().trim().min(1).optional().describe(description);
const positiveInteger = (description: string) =>
  z.coerce.number<number>().int().positive().describe(description);

export const FalkorDBOptionsSchema = z
  .object({
    dataDir: text("Active local FalkorDB directory.").meta({ env: "FALKORDB_DATA_DIR" }),
    snapshotSeconds: positiveInteger("Redis snapshot interval in seconds.")
      .default(300)
      .meta({ env: "FALKORDB_SNAPSHOT_SECONDS" }),
    snapshotMinChanges: positiveInteger("Writes required before an interval saves.")
      .default(1)
      .meta({ env: "FALKORDB_SNAPSHOT_MIN_CHANGES" }),
    volume: text("Durable Unity Catalog Volume directory.").meta({ env: "FALKORDB_VOLUME" }),
    profile: options.DatabricksOptionsSchema.shape.profile.describe(
      "Exact Databricks profile used for Volume access.",
    ),
    retention: positiveInteger("Durable snapshots retained.").default(5),
    backupPollSeconds: positiveInteger("Completed-RDB polling interval in seconds.").default(10),
    staleBackupWarningSeconds: positiveInteger(
      "Seconds before warning that changed data lacks a recent durable backup.",
    ).optional(),
    forceBackupOnShutdown: z
      .boolean()
      .default(false)
      .describe("Force a dirty RDB and durable upload before shutdown."),
    shutdownTimeoutSeconds: positiveInteger("Shutdown backup timeout in seconds.").default(30),
    redisServerPath: text("Custom redis-server executable."),
    modulePath: text("Custom FalkorDB module."),
    maxMemory: text("Redis memory limit such as 256mb."),
    redisLogLevel: z
      .enum(["debug", "verbose", "notice", "warning"])
      .optional()
      .describe("Redis log level."),
    redisLogFile: text("Redis log file."),
    startupTimeoutSeconds: positiveInteger("Embedded server startup timeout in seconds.").default(
      10,
    ),
    inheritStdio: z.boolean().default(false).describe("Inherit redis-server stdout and stderr."),
  })
  .strict()
  .describe("Foreground embedded FalkorDB command-line options.");

export type FalkorDBOptions = z.output<typeof FalkorDBOptionsSchema>;
