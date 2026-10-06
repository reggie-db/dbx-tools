/**
 * Commander parser for the foreground embedded FalkorDB CLI.
 *
 * This module is the single owner for user-facing command names, defaults,
 * environment variables, validation, and generated help. It intentionally has
 * no service subcommand or dependency on `@dbx-tools/cli-service`.
 *
 * @module
 */

import { addArgs, parseArgs } from "@dbx-tools/cli-args/args";
import { Command } from "commander";

import { PACKAGE_VERSION } from "../index.ts";
import { FalkorDBOptionsSchema, type FalkorDBOptions } from "./options.ts";
import { runFalkorDB } from "./runtime.ts";

/** Injectable foreground runtime boundary for CLI composition and tests. */
export interface FalkorDBCliDependencies {
  run(options: FalkorDBOptions): Promise<void>;
}

const DEFAULT_DEPENDENCIES: FalkorDBCliDependencies = { run: runFalkorDB };

/** Build the foreground-only FalkorDB command without starting the database. */
export function buildProgram(
  name = "dbx falkor-db",
  dependencies: FalkorDBCliDependencies = DEFAULT_DEPENDENCIES,
): Command {
  const program = addArgs(
    new Command()
      .name(name)
      .description("Run embedded FalkorDB with change-aware local and durable snapshots")
      .showHelpAfterError()
      .version(PACKAGE_VERSION, "-v, --version"),
    FalkorDBOptionsSchema,
    { scope: [] },
  );
  return program.action(async () => {
    await dependencies.run(parseArgs(program, FalkorDBOptionsSchema));
  });
}
