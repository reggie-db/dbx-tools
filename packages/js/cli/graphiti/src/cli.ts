/**
 * Foreground Graphiti CLI and shared current-user service definition.
 *
 * Reuse the runtime module for bootstrap and `buildServiceCommand` for desktop
 * lifecycle. Python remains the owner of Graphiti start arguments and backend
 * supervision; this CLI does not reproduce either policy.
 *
 * @module
 */
import { buildServiceCommand, type CliServiceCliDependencies } from "@dbx-tools/cli-service/cli";
import { defineService, type CliServiceDefinition } from "@dbx-tools/cli-service/definition";
import { Command, Option } from "commander";
import { PACKAGE_VERSION } from "../index.ts";
import {
  ensureGraphitiModelGateway,
  ensureGraphitiPython,
  startGraphiti,
  type GraphitiRuntimeOptions,
} from "./runtime.ts";

/** Injectable foreground and shared lifecycle boundaries for CLI callers. */
export interface GraphitiCliDependencies {
  /** Start the Python-owned foreground stack. */
  start(options: GraphitiRuntimeOptions): Promise<void>;
  /** Bootstrap the matching Python runtime before service installation. */
  readonly prepare?: (python: string) => Promise<void>;
  /** Shared service command dependencies for tests and embedding. */
  readonly service?: CliServiceCliDependencies;
}

/** Runtime-owned options persisted when installing the Graphiti desktop service. */
export type GraphitiServiceOptions = Pick<GraphitiRuntimeOptions, "python" | "profile">;

/** Define a Graphiti service without duplicating installation or lifecycle policy. */
export function graphitiServiceDefinition(
  options: GraphitiServiceOptions = {},
): CliServiceDefinition {
  return defineService(import.meta.url, {
    command: {
      executable: options.python ?? process.env.PYTHON ?? "python3",
      arguments: [
        "-m",
        "dbx_tools.graphiti",
        "start",
        ...(options.profile ? ["--profile", options.profile] : []),
      ],
      environment: {
        MANAGE_MODEL_GATEWAY: process.env.MANAGE_MODEL_GATEWAY ?? "true",
        MODEL_GATEWAY_COMMAND: process.env.MODEL_GATEWAY_COMMAND ?? ensureGraphitiModelGateway(),
      },
    },
  });
}

/** Build foreground and shared service commands without starting any processes. */
export function buildProgram(
  name = "dbx graphiti",
  dependencies: GraphitiCliDependencies = { start: startGraphiti },
): Command {
  const program = new Command()
    .name(name)
    .description("Run Graphiti or manage its current-user desktop service")
    .version(PACKAGE_VERSION, "-v, --version")
    .addOption(
      new Option("--python <python>", "Python executable used to run Graphiti")
        .env("PYTHON")
        .default("python3"),
    )
    .option("--profile <profile>", "Databricks profile used for model requests")
    .argument("[args...]", "arguments forwarded to the Python Graphiti start command")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (args: string[], options: GraphitiServiceOptions) => {
      await dependencies.start({ ...options, args });
    });
  program.hook("preAction", async (_command, action) => {
    if (action.name() === "install") {
      await (dependencies.prepare ?? ensureGraphitiPython)(
        program.opts<GraphitiServiceOptions>().python ?? "python3",
      );
    }
  });
  program.addCommand(
    buildServiceCommand(
      () => graphitiServiceDefinition(program.opts<GraphitiServiceOptions>()),
      dependencies.service,
    ),
  );
  return program;
}
