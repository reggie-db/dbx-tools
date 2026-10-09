/**
 * Commander-owned Graphiti CLI and shared current-user service definition.
 *
 * This module owns every user-facing Graphiti command. The shared Graphiti Zod
 * schema owns its options, environment names, defaults, and validation. The
 * Node Graphiti package owns runtime and Python interaction.
 *
 * @module
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { runGraphiti, type GraphitiRuntimeOptions } from "@dbx-tools/appkit-graphiti/runtime";
import { addArgs, parseArgs, serializeArgs } from "@dbx-tools/cli-args";
import { buildServiceCommand, type CliServiceCliDependencies } from "@dbx-tools/cli-service/cli";
import { defineService, type CliServiceDefinition } from "@dbx-tools/cli-service/definition";
import { serviceTrayIcon } from "@dbx-tools/cli-service/icon";
import { Command } from "commander";

import {
  GraphitiCliOptionsSchema,
  GraphitiOptionsSchema,
  type GraphitiOptions,
} from "./options.ts";
import { PACKAGE_VERSION } from "../../index.ts";

const DEFAULT_SERVICE_DIRECTORY = join(homedir(), ".dbx-tools", "services", "graphiti");
const DEFAULT_SERVICE_HOME = join(homedir(), ".dbx-tools", "graphiti");

/** Injectable runtime and service lifecycle boundaries for CLI callers. */
export interface GraphitiCliDependencies {
  /** Run the Graphiti stack through the Node runtime owner. */
  run(options: GraphitiRuntimeOptions): Promise<void>;
  /** Shared service command dependencies for tests and embedding. */
  readonly service?: CliServiceCliDependencies;
}

/** Runtime options persisted when installing the Graphiti desktop service. */
export type GraphitiServiceOptions = GraphitiOptions;

/** Define a Graphiti service without duplicating installation or lifecycle policy. */
export function graphitiServiceDefinition(
  options: GraphitiServiceOptions = {},
): CliServiceDefinition {
  const resolved = GraphitiOptionsSchema.parse({
    ...options,
    graphitiHome: options.graphitiHome ?? DEFAULT_SERVICE_HOME,
  });
  return defineService(import.meta.url, {
    id: "dbx-tools.cli-graphiti",
    name: "dbx graphiti",
    icon: serviceTrayIcon("graphiti"),
    dataDirectory: DEFAULT_SERVICE_DIRECTORY,
    pythonPackage: {
      name: resolved.databaseUrl ? "dbx-tools-graphiti" : "dbx-tools-graphiti[dev]",
    },
    command: {
      binName: "dbx-graphiti",
      arguments: serializeArgs(resolved),
    },
  });
}

/** Build foreground execution and shared desktop-service commands. */
export function buildProgram(
  name = "dbx graphiti",
  dependencies: GraphitiCliDependencies = { run: runGraphiti },
): Command {
  const program = addArgs(
    new Command()
      .name(name)
      .description("Run Graphiti or manage its current-user desktop service")
      .version(PACKAGE_VERSION, "-v, --version"),
    GraphitiCliOptionsSchema,
  ).action(async () => {
    await dependencies.run(graphitiOptions(program));
  });

  program.addCommand(
    buildServiceCommand(
      () => graphitiServiceDefinition(graphitiOptions(program)),
      dependencies.service,
    ),
  );
  return program;
}

function graphitiOptions(command: Command): GraphitiOptions {
  return GraphitiOptionsSchema.parse(parseArgs(command, GraphitiCliOptionsSchema));
}
