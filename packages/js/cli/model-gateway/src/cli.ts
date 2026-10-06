/**
 * Foreground `dbx model-gateway` command.
 *
 * @module
 */

import { addArgs, parseArgs } from "@dbx-tools/cli-args/args";
import { buildServiceCommand, type CliServiceCliDependencies } from "@dbx-tools/cli-service/cli";
import { defineService, type CliServiceDefinition } from "@dbx-tools/cli-service/definition";
import {
  ModelGatewayCliOptionsSchema,
  resolveModelGatewayCliOptions,
  type ModelGatewayCliOptions,
  type ModelGatewayOptions,
} from "@dbx-tools/shared-model-gateway/options";
import { Command } from "commander";

import { PACKAGE_VERSION } from "../index.ts";
import { startModelGateway } from "./server.ts";

/** Injectable foreground gateway boundary for CLI tests. */
export interface ModelGatewayCliDependencies {
  start(options: ModelGatewayOptions): Promise<void>;
  /** Optional service CLI boundary for tests and embedding. */
  readonly service?: CliServiceCliDependencies;
}

const DEFAULT_DEPENDENCIES: ModelGatewayCliDependencies = {
  start: startModelGateway,
};

/** Build the tray-only model-gateway service definition. */
export function modelGatewayServiceDefinition(
  options: ModelGatewayOptions = {},
): CliServiceDefinition {
  const { runtimeInfo: _, ...resolved } = resolveModelGatewayCliOptions(options);
  const host = urlHost(resolved.listen.host);
  return defineService(import.meta.url, {
    command: {
      options: resolved,
    },
    menu: [
      {
        type: "url",
        label: "Models",
        url: `http://${host}:${resolved.listen.port}/v1/models`,
      },
    ],
  });
}

/** Build foreground and service model-gateway commands without starting a server. */
export function buildProgram(
  name = "dbx model-gateway",
  dependencies: ModelGatewayCliDependencies = DEFAULT_DEPENDENCIES,
): Command {
  const version = PACKAGE_VERSION;
  const program = addArgs(
    new Command()
      .name(name)
      .description("Run or manage the AppKit Databricks model gateway")
      .version(version, "-v, --version"),
    ModelGatewayCliOptionsSchema,
    { scope: [] },
  ).action(async () => {
    const options = modelGatewayOptions(program);
    if (options.runtimeInfo) {
      process.stdout.write(`${JSON.stringify({ implementation: "typescript-appkit", version })}\n`);
      return;
    }
    const { runtimeInfo: _, ...serverOptions } = options;
    await dependencies.start(serverOptions);
  });
  const serviceCommand = buildServiceCommand(() => {
    return modelGatewayServiceDefinition(modelGatewayOptions(program));
  }, dependencies.service);
  program.addCommand(serviceCommand);
  return program;
}

function modelGatewayOptions(command: Command): ModelGatewayCliOptions {
  return parseArgs(command, ModelGatewayCliOptionsSchema);
}

function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
