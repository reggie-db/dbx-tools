/**
 * Commander-owned Graphiti CLI and shared current-user service definition.
 *
 * This module owns every user-facing Graphiti command. The shared Graphiti Zod
 * schema owns its options, environment names, defaults, and validation for both
 * this CLI and the generated Python binding.
 *
 * @module
 */
import { addArgs, parseArgs, serializeArgs } from "@dbx-tools/cli-args/args";
import { buildServiceCommand, type CliServiceCliDependencies } from "@dbx-tools/cli-service/cli";
import { defineService, type CliServiceDefinition } from "@dbx-tools/cli-service/definition";
import {
  GraphitiCliOptionsSchema,
  GraphitiOptionsSchema,
  resolveGraphitiOptions,
  type GraphitiOptions,
} from "@dbx-tools/shared-graphiti";
import { Command } from "commander";
import { PACKAGE_VERSION } from "../index.ts";
import {
  ensureGraphitiModelGateway,
  ensureGraphitiPython,
  runGraphiti,
  type GraphitiRuntimeOptions,
} from "./runtime.ts";

/** Injectable runtime and service lifecycle boundaries for CLI callers. */
export interface GraphitiCliDependencies {
  /** Run the Node-supervised Graphiti stack. */
  run(options: GraphitiRuntimeOptions): Promise<void>;
  /** Ensure the matching Python package before service installation. */
  readonly prepare?: (python: string) => Promise<void>;
  /** Shared service command dependencies for tests and embedding. */
  readonly service?: CliServiceCliDependencies;
}

/** Runtime options persisted when installing the Graphiti desktop service. */
export type GraphitiServiceOptions = GraphitiOptions;

/** Define a Graphiti service without duplicating installation or lifecycle policy. */
export function graphitiServiceDefinition(
  options: GraphitiServiceOptions = {},
): CliServiceDefinition {
  const parsed = GraphitiOptionsSchema.parse({
    ...options,
    modelGatewayCommand: options.modelGatewayCommand ?? ensureGraphitiModelGateway(),
  });
  const { graphitiArgs, ...cliOptions } = parsed;
  return defineService(import.meta.url, {
    command: {
      arguments: [...serializeArgs(cliOptions), ...graphitiArgs],
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
    { scope: [] },
  )
    .argument("[args...]", "arguments forwarded to the pinned Graphiti MCP server")
    .action(async (args: string[]) => {
      await dependencies.run(graphitiOptions(program, args));
    });

  program.hook("preAction", async (_command, action) => {
    if (action.name() === "install") {
      const options = graphitiOptions(program);
      await (dependencies.prepare ?? ensureGraphitiPython)(resolveGraphitiOptions(options).python);
    }
  });
  program.addCommand(
    buildServiceCommand(
      () => graphitiServiceDefinition(graphitiOptions(program)),
      dependencies.service,
    ),
  );
  return program;
}

function graphitiOptions(command: Command, graphitiArgs: readonly string[] = []): GraphitiOptions {
  return GraphitiOptionsSchema.parse({
    ...parseArgs(command, GraphitiCliOptionsSchema),
    graphitiArgs: [...graphitiArgs],
  });
}
