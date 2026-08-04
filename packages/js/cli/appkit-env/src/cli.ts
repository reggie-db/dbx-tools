/**
 * `dbx appkit` commander program.
 *
 * `env` runs AppKit auto-config and prints the env vars it added or changed as
 * eval-able `export` / `set` lines (or JSON) - e.g. `eval "$(dbx appkit env)"`
 * to load a resolved Lakebase connection into your shell.
 *
 * This package ships no bin of its own: {@link buildProgram} is mounted as the
 * `appkit` subcommand of the single `dbx` CLI (`@dbx-tools/cli`), which imports
 * this module lazily so `dbx dev` never pays for the AppKit load.
 *
 * @module
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
} from "./env-export.ts";

const logger = log.logger("appkit-env");

/** Options for the `env` command. */
interface EnvOpts {
  format?: string;
  quiet?: boolean;
}

/** Run auto-config and write the resulting env delta to stdout. */
async function writeEnvExport(opts: EnvOpts): Promise<void> {
  if (opts.quiet) {
    process.env.LOG_LEVEL = "error";
  }

  const format = opts.format ? parseEnvExportFormat(opts.format) : defaultEnvExportFormat();
  logger.debug("Snapshotting env vars");
  const before = snapshotEnv();
  await appkit.autoConfigure({ autoConfigure: "env" });
  const changes = diffEnv(before, snapshotEnv());

  process.stdout.write(formatEnvExport(changes, format));
}

/**
 * Build the `env` command on its own, so a host CLI can mount it under a
 * different parent than {@link buildProgram}'s.
 */
export function buildEnvCommand(name = "env"): Command {
  return new Command(name)
    .description("Run AppKit auto-config and print new/changed env vars.")
    .option(
      "-f, --format <format>",
      "Output: export (POSIX shell), windows (cmd set), or json. Defaults by platform.",
    )
    .option("-q, --quiet", "Suppress auto-config log output (LOG_LEVEL=error)")
    .action(writeEnvExport);
}

/** Build the `dbx appkit` commander program (no side effects until parsed). */
export function buildProgram(name = "dbx appkit"): Command {
  return new Command()
    .name(name)
    .description("AppKit helpers: resolve the environment an AppKit app would start with.")
    .addCommand(buildEnvCommand())
    .showHelpAfterError();
}

/** Parse `argv` and run the matching command. Throws {@link CommanderError} on flag errors. */
export async function runCli(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}

export { CommanderError };
