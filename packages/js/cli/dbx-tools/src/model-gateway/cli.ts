/**
 * Foreground `dbx model-gateway` command.
 *
 * @module
 */

import { readFile } from "node:fs/promises";
import { addArgs, parseArgs, serializeArgs } from "@dbx-tools/cli-args";
import {
  buildServiceCommand,
  type CliServiceCliDependencies,
  defineService,
  type CliServiceDefinition,
} from "@dbx-tools/cli-service";
import {
  ModelGatewayCliOptionsSchema,
  resolveModelGatewayCliOptions,
  type ModelGatewayCliOptions,
  type ModelGatewayOptions,
} from "@dbx-tools/shared-model-gateway";
import { Command } from "commander";

import { selectSmartRouterModel, startModelGateway } from "./server.ts";
import { PACKAGE_VERSION } from "../../index.ts";

/** Injectable foreground gateway boundary for CLI tests. */
export interface ModelGatewayCliDependencies {
  start(options: ModelGatewayOptions): Promise<void>;
  select?(options: ModelGatewayOptions, input: unknown): Promise<Readonly<Record<string, unknown>>>;
  /** Optional service CLI boundary for tests and embedding. */
  readonly service?: CliServiceCliDependencies;
}

const DEFAULT_DEPENDENCIES: ModelGatewayCliDependencies = {
  start: startModelGateway,
  select: selectSmartRouterModel,
};

/** Build the tray-only model-gateway service definition. */
export function modelGatewayServiceDefinition(
  options: ModelGatewayOptions = {},
): CliServiceDefinition {
  const {
    runtimeInfo: _,
    bearerToken: _bearerToken,
    selectModelFrom: _selectModelFrom,
    ...resolved
  } = resolveModelGatewayCliOptions(options);
  const host = urlHost(resolved.listen.host);
  return defineService(import.meta.url, {
    id: "dbx-tools.cli-model-gateway",
    name: "dbx model gateway",
    command: {
      binName: "dbx-model-gateway",
      arguments: serializeArgs(resolved),
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
  ).action(async () => {
    const options = modelGatewayOptions(program);
    if (options.runtimeInfo) {
      process.stdout.write(`${JSON.stringify({ implementation: "typescript-appkit", version })}\n`);
      return;
    }
    const { runtimeInfo: _, selectModelFrom, ...serverOptions } = options;
    if (selectModelFrom) {
      const input = await readSelectionInput(selectModelFrom);
      const selected = await (dependencies.select ?? selectSmartRouterModel)(serverOptions, input);
      process.stdout.write(`${JSON.stringify(selected, null, 2)}\n`);
      return;
    }
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

async function readSelectionInput(path: string): Promise<unknown> {
  const text = path === "-" ? await readStandardInput() : await readFile(path, "utf8");
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Smart Router selection input is empty");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

async function readStandardInput(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}
