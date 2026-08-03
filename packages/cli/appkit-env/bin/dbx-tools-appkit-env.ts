#!/usr/bin/env node
/**
 * `dbx-tools-appkit-env`: run AppKit auto-config and print the env vars it added or
 * changed. Snapshots `process.env`, runs auto-config, diffs, and writes
 * eval-able `export` / `set` lines (or JSON) to stdout - e.g.
 * `eval "$(dbx-tools-appkit-env)"` to load a resolved Lakebase connection into your shell.
 */

import { appkit } from "@dbx-tools/appkit";
import { log } from "@dbx-tools/shared-core";
import { Command, CommanderError } from "commander";
import {
  defaultEnvExportFormat,
  diffEnv,
  formatEnvExport,
  parseEnvExportFormat,
  snapshotEnv,
} from "../src/env-export.ts";

const logger = log.logger("appkit-env");

const program = new Command()
  .name("dbx-tools-appkit-env")
  .description("Run AppKit auto-config and print new/changed env vars.")
  .option(
    "-f, --format <format>",
    "Output: export (POSIX shell), windows (cmd set), or json. Defaults by platform.",
  )
  .option("-q, --quiet", "Suppress auto-config log output (LOG_LEVEL=error)")
  .action(async (opts: { format?: string; quiet?: boolean }) => {
    if (opts.quiet) {
      process.env.LOG_LEVEL = "error";
    }

    const format = opts.format ? parseEnvExportFormat(opts.format) : defaultEnvExportFormat();
    logger.debug("Snapshotting env vars");
    const before = snapshotEnv();
    await appkit.autoConfigure({ autoConfigure: "env" });
    const changes = diffEnv(before, snapshotEnv());

    process.stdout.write(formatEnvExport(changes, format));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CommanderError) {
    process.exit(err.exitCode);
  }
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
