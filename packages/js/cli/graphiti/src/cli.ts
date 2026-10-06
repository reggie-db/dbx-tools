/**
 * Commander-owned Graphiti CLI and shared current-user service definition.
 *
 * This module owns every user-facing Graphiti command. The shared Graphiti Zod
 * schema owns its options, environment names, defaults, and validation. The
 * Node Graphiti package owns runtime and Python interaction.
 *
 * @module
 */
import { addArgs, parseArgs, serializeArgs } from "@dbx-tools/cli-args/args";
import { buildServiceCommand, type CliServiceCliDependencies } from "@dbx-tools/cli-service/cli";
import { defineService, type CliServiceDefinition } from "@dbx-tools/cli-service/definition";
import { runGraphiti, type GraphitiRuntimeOptions } from "@dbx-tools/graphiti/runtime";
import { GRAPHITI_UPSTREAM_PYTHON_DEPENDENCIES } from "@dbx-tools/shared-graphiti/upstream";
import { Command } from "commander";
import {
  GraphitiCliOptionsSchema,
  GraphitiOptionsSchema,
  type GraphitiOptions,
} from "./options.ts";
import { PACKAGE_VERSION } from "../index.ts";

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
  return defineService(import.meta.url, {
    pythonPackage: {
      name: "dbx-tools-graphiti",
      dependencies: [...GRAPHITI_UPSTREAM_PYTHON_DEPENDENCIES],
    },
    command: {
      arguments: serializeArgs(GraphitiOptionsSchema.parse(options)),
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
