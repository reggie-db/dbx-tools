/**
 * Commander parser for the foreground embedded FalkorDB CLI.
 *
 * This module is the single owner for user-facing command names, defaults,
 * environment variables, validation, and generated help. It intentionally has
 * no service subcommand or dependency on `@dbx-tools/cli-service`.
 *
 * @module
 */

import { Command, InvalidArgumentError, Option } from "commander";

import { PACKAGE_VERSION } from "../index.ts";
import { runFalkorDB, type RunFalkorDBOptions } from "./runtime.ts";

/** Injectable foreground runtime boundary for CLI composition and tests. */
export interface FalkorDBCliDependencies {
  run(options: RunFalkorDBOptions): Promise<void>;
}

const DEFAULT_DEPENDENCIES: FalkorDBCliDependencies = { run: runFalkorDB };

/** Build the foreground-only FalkorDB command without starting the database. */
export function buildProgram(
  name = "dbx falkor-db",
  dependencies: FalkorDBCliDependencies = DEFAULT_DEPENDENCIES,
): Command {
  return new Command()
    .name(name)
    .description("Run embedded FalkorDB with change-aware local and durable snapshots")
    .showHelpAfterError()
    .version(PACKAGE_VERSION, "-v, --version")
    .addOption(
      new Option("--data-dir <path>", "active local FalkorDB directory").env("FALKORDB_DATA_DIR"),
    )
    .addOption(
      new Option("--snapshot-seconds <seconds>", "Redis snapshot interval")
        .argParser(positiveInteger)
        .default(300)
        .env("FALKORDB_SNAPSHOT_SECONDS"),
    )
    .addOption(
      new Option("--snapshot-min-changes <count>", "writes required before an interval saves")
        .argParser(positiveInteger)
        .default(1)
        .env("FALKORDB_SNAPSHOT_MIN_CHANGES"),
    )
    .addOption(
      new Option("--volume <path>", "durable Unity Catalog Volume directory").env(
        "FALKORDB_VOLUME",
      ),
    )
    .addOption(
      new Option("--profile <name>", "exact Databricks profile used for Volume access").env(
        "DATABRICKS_CONFIG_PROFILE",
      ),
    )
    .addOption(
      new Option("--retention <count>", "durable snapshots retained")
        .argParser(positiveInteger)
        .default(5),
    )
    .addOption(
      new Option("--backup-poll-seconds <seconds>", "completed-RDB polling interval")
        .argParser(positiveInteger)
        .default(10),
    )
    .addOption(
      new Option(
        "--stale-backup-warning-seconds <seconds>",
        "warn when changed data lacks a recent durable backup",
      ).argParser(positiveInteger),
    )
    .option("--force-backup-on-shutdown", "force a dirty RDB and durable upload before shutdown")
    .addOption(
      new Option("--shutdown-timeout-seconds <seconds>", "shutdown backup timeout")
        .argParser(positiveInteger)
        .default(30),
    )
    .option("--redis-server-path <path>", "custom redis-server executable")
    .option("--module-path <path>", "custom FalkorDB module")
    .option("--max-memory <limit>", "Redis memory limit such as 256mb")
    .addOption(
      new Option("--redis-log-level <level>", "Redis log level").choices([
        "debug",
        "verbose",
        "notice",
        "warning",
      ]),
    )
    .option("--redis-log-file <path>", "Redis log file")
    .addOption(
      new Option("--startup-timeout-seconds <seconds>", "embedded server startup timeout")
        .argParser(positiveInteger)
        .default(10),
    )
    .option("--inherit-stdio", "inherit redis-server stdout and stderr")
    .action(async (options: RunFalkorDBOptions) => {
      await dependencies.run(options);
    });
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("value must be a positive integer");
  }
  return parsed;
}
