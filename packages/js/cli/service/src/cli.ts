/**
 * Commander command group for the shared system-tray service lifecycle.
 *
 * Consuming CLIs should mount {@link buildServiceCommand} instead of defining
 * package-local install/start/stop/status commands with divergent behavior.
 *
 * @module
 */

import { addArgs, parseArgs } from "@dbx-tools/cli-args";
import * as exec from "@dbx-tools/core/exec";
import { Command } from "commander";

import type { CliServiceDefinition } from "./definition.ts";
import { CliService, CliServiceInstallOptionsSchema, type CliServiceLifecycle } from "./service.ts";

export { CliServiceInstallOptionsSchema, type CliServiceInstallOptions } from "./service.ts";

/** Static definition or action-time factory used by a service command group. */
export type CliServiceDefinitionSource = CliServiceDefinition | (() => CliServiceDefinition);

/** Injectable lifecycle and output boundary for service CLI tests and composition. */
export interface CliServiceCliDependencies {
  /** Construct the lifecycle manager used by command actions. */
  create(definition: CliServiceDefinition): CliServiceLifecycle;
  /** Write the JSON result of the status command. */
  write(value: string): void;
  /** Run a caller-supplied command with inherited terminal input and output. */
  readonly execute?: (command: string, arguments_: readonly string[]) => Promise<void>;
}

const DEFAULT_DEPENDENCIES = {
  create: (definition) => new CliService(definition),
  write: (value) => process.stdout.write(value),
  execute: async (command: string, arguments_: readonly string[]) => {
    await exec.spawn(command, arguments_, { check: true });
  },
} satisfies CliServiceCliDependencies;

/** Build install, start, stop, restart, status, logs, and uninstall commands for a service. */
export function buildServiceCommand(
  source: CliServiceDefinitionSource,
  dependencies: CliServiceCliDependencies = DEFAULT_DEPENDENCIES,
): Command {
  const definition = resolveDefinition(source);
  const service = () => dependencies.create(definition());
  const execute = dependencies.execute ?? DEFAULT_DEPENDENCIES.execute;
  const command = new Command("service")
    .enablePositionalOptions()
    .description(
      typeof source === "function"
        ? "Install and manage the desktop service"
        : `Install and manage the ${source.name} desktop service`,
    );

  const install = addArgs(
    command.command("install").description("Install the service for the current user and start it"),
    CliServiceInstallOptionsSchema,
  );
  install.action(async () => {
    await service().install(parseArgs(install, CliServiceInstallOptionsSchema));
  });

  command
    .command("start")
    .description("Start the installed service")
    .action(async () => {
      await service().start();
    });

  command
    .command("stop")
    .description("Stop the running service")
    .action(async () => {
      await service().stop();
    });

  command
    .command("restart")
    .description("Restart the installed service")
    .action(async () => {
      await service().restart();
    });

  command
    .command("status")
    .description("Print service installation and process state as JSON")
    .action(async () => {
      dependencies.write(`${JSON.stringify(await service().status(), null, 2)}\n`);
    });

  command
    .command("logs")
    .description("Print the service log path or append it to a command")
    .argument("[command...]", "Command and arguments to run before the service log path")
    .allowUnknownOption()
    .passThroughOptions()
    .allowExcessArguments()
    .action(async (commandArguments: string[]) => {
      const logPath = service().logPath();
      if (commandArguments.length === 0) {
        dependencies.write(`${logPath}\n`);
        return;
      }
      const [executable, ...arguments_] = commandArguments;
      await execute(executable!, [...arguments_, logPath]);
    });

  command
    .command("uninstall")
    .description("Stop and remove the service for the current user")
    .action(async () => {
      await service().uninstall();
    });

  return command;
}

function resolveDefinition(source: CliServiceDefinitionSource): () => CliServiceDefinition {
  return typeof source === "function" ? source : () => source;
}
