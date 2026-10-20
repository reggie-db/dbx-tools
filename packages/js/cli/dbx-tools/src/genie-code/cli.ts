/**
 * Managed `dbx genie` command.
 *
 * @module
 */

import { addArgs, parseArgs } from "@dbx-tools/cli-args";
import { GenieCodeOptionsSchema, type GenieCodeOptions } from "@dbx-tools/shared-genie-code";
import { Command } from "commander";

import { runGenieCode } from "./runtime.ts";

/** Injectable managed Genie execution boundary for parser tests and embedding. */
export interface GenieCodeCliDependencies {
  run(input: {
    cwd: string;
    genieArgs: readonly string[];
    options: GenieCodeOptions;
  }): Promise<void>;
}

const DEFAULT_DEPENDENCIES: GenieCodeCliDependencies = {
  run: runGenieCode,
};

/** Build the managed Genie Code command without executing it. */
export function buildProgram(
  name = "dbx genie",
  dependencies: GenieCodeCliDependencies = DEFAULT_DEPENDENCIES,
): Command {
  const program = addArgs(
    new Command()
      .name(name)
      .description("Run Genie Code through an authenticated local Databricks model gateway")
      .argument(
        "[genieArgs...]",
        "Arguments and unknown flags forwarded to Genie Code. Separate wrapper options with --",
      )
      .allowUnknownOption()
      .passThroughOptions()
      .allowExcessArguments()
      .showHelpAfterError(),
    GenieCodeOptionsSchema,
  );
  program.action(async (genieArgs: string[]) => {
    await dependencies.run({
      cwd: process.cwd(),
      genieArgs,
      options: parseArgs(program, GenieCodeOptionsSchema),
    });
  });
  return program;
}

/** Parse argv and run managed Genie Code. */
export async function runCli(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}
