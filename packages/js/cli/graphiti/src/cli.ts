/**
 * Commander-owned Graphiti CLI and shared current-user service definition.
 *
 * This module owns every user-facing Graphiti command. The shared Graphiti Zod
 * schema owns its options, environment names, defaults, and validation for both
 * this CLI and the generated Python binding.
 *
 * @module
 */
import { addArgs, parseArgs } from "@dbx-tools/cli-args/args";
import { buildServiceCommand, type CliServiceCliDependencies } from "@dbx-tools/cli-service/cli";
import { defineService, type CliServiceDefinition } from "@dbx-tools/cli-service/definition";
import {
  GRAPHITI_COMMAND_ENV,
  GraphitiCliOptionsSchema,
  GRAPHITI_OPTIONS_ENV,
  GraphitiOptionsSchema,
  resolveGraphitiOptions,
  serializeGraphitiOptions,
  type GraphitiCommand,
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
  /** Run one Python Graphiti operation. */
  run(command: GraphitiCommand, options: GraphitiRuntimeOptions): Promise<void>;
  /** Bootstrap the matching Python runtime before service installation. */
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
  const resolved = resolveGraphitiOptions({
    ...options,
    modelGatewayCommand: options.modelGatewayCommand ?? ensureGraphitiModelGateway(),
  });
  return defineService(import.meta.url, {
    command: {
      executable: resolved.python,
      arguments: ["-m", "dbx_tools.graphiti"],
      environment: {
        [GRAPHITI_COMMAND_ENV]: "start",
        [GRAPHITI_OPTIONS_ENV]: serializeGraphitiOptions(resolved),
      },
    },
  });
}

/** Build foreground, detached, inspection, and shared service commands. */
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
      await dependencies.run("start", graphitiOptions(program, args));
    });

  for (const [commandName, description] of [
    ["start", "Start Neo4j, the model gateway, and Graphiti in the foreground"],
    ["up", "Start Neo4j, the model gateway, and Graphiti in the background"],
  ] as const) {
    program.addCommand(
      new Command(commandName)
        .description(description)
        .argument("[args...]", "arguments forwarded to the pinned Graphiti MCP server")
        .action(async (args: string[]) => {
          await dependencies.run(commandName, graphitiOptions(program, args));
        }),
    );
  }
  for (const [commandName, description] of [
    ["down", "Stop Graphiti, the model gateway, and Neo4j"],
    ["status", "Show native process and endpoint status"],
    ["env", "Print resolved runtime and connection settings"],
  ] as const) {
    program.addCommand(
      new Command(commandName).description(description).action(async () => {
        await dependencies.run(commandName, graphitiOptions(program));
      }),
    );
  }

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
