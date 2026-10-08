/**
 * Commander command group for the shared system-tray service lifecycle.
 *
 * Consuming CLIs should mount {@link buildServiceCommand} instead of defining
 * package-local install/start/stop/status commands with divergent behavior.
 *
 * @module
 */

import { Command } from "commander";
import { z } from "zod";

import type { CliServiceDefinition } from "./definition.ts";
import { CliService, type CliServiceLifecycle } from "./service.ts";

/** Static definition or action-time factory used by a service command group. */
export type CliServiceDefinitionSource = CliServiceDefinition | (() => CliServiceDefinition);

/** Injectable lifecycle and output boundary for service CLI tests and composition. */
export interface CliServiceCliDependencies {
  /** Construct the lifecycle manager used by command actions. */
  create(definition: CliServiceDefinition): CliServiceLifecycle;
  /** Write the JSON result of the status command. */
  write(value: string): void;
}

const DEFAULT_DEPENDENCIES: CliServiceCliDependencies = {
  create: (definition) => new CliService(definition),
  write: (value) => process.stdout.write(value),
};

export const CliServiceInstallOptionsSchema = z
  .object({
    start: z.boolean().default(true).describe("Start the service after installation."),
  })
  .strict()
  .describe("Options for installing a current-user CLI service.");

export type CliServiceInstallOptions = z.output<typeof CliServiceInstallOptionsSchema>;

/** Build install, start, stop, restart, status, and uninstall commands for a service. */
export function buildServiceCommand(
  source: CliServiceDefinitionSource,
  dependencies: CliServiceCliDependencies = DEFAULT_DEPENDENCIES,
): Command {
  const definition = resolveDefinition(source);
  const service = () => dependencies.create(definition());
  const command = new Command("service").description(
    typeof source === "function"
      ? "Install and manage the desktop service"
      : `Install and manage the ${source.name} desktop service`,
  );

  const install = command
    .command("install")
    .description("Install the service for the current user and start it")
    .option("--no-start", "Do not start the service after installation");
  install.action(async () => {
    const options = CliServiceInstallOptionsSchema.parse({
      start: install.getOptionValue("start"),
    });
    await service().install({ start: options.start });
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
