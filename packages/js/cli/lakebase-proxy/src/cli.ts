/** Commander entry point for the pure Node Lakebase proxy. */

import { addArgs, parseArgs } from "@dbx-tools/cli-args/args";
import { buildServiceCommand, type CliServiceCliDependencies } from "@dbx-tools/cli-service/cli";
import { defineService, type CliServiceDefinition } from "@dbx-tools/cli-service/definition";
import { connectionUrl } from "@dbx-tools/lakebase";
import { Command } from "commander";

import { PACKAGE_VERSION } from "../index.ts";
import {
  LakebaseProxyOptionsSchema,
  LakebaseProxyUrlOptionsSchema,
  resolveLakebaseProxyOptions,
  type LakebaseProxyOptions,
} from "./options.ts";
import { LakebaseProxy } from "./proxy.ts";

/** Injectable service boundary for Lakebase proxy CLI composition and tests. */
export interface LakebaseProxyCliDependencies {
  readonly service?: CliServiceCliDependencies;
}

/** Build the tray-only Lakebase proxy service definition. */
export function lakebaseProxyServiceDefinition(
  options: LakebaseProxyOptions = {},
): CliServiceDefinition {
  const resolved = resolveLakebaseProxyOptions(options);
  return defineService(import.meta.url, {
    command: {
      options: resolved,
    },
  });
}

/** Build the Lakebase proxy command-line program. */
export function buildProgram(
  name = "dbx lakebase-proxy",
  dependencies: LakebaseProxyCliDependencies = {},
): Command {
  const program = addArgs(
    new Command(name)
      .description("Run a loopback PostgreSQL proxy for Databricks Lakebase")
      .version(PACKAGE_VERSION)
      .enablePositionalOptions(),
    LakebaseProxyOptionsSchema,
    { scope: [] },
  ).action(async () => {
    const proxy = new LakebaseProxy(parseArgs(program, LakebaseProxyOptionsSchema));
    await proxy.listen();
    await waitForShutdown();
    await proxy.close();
  });

  const urlCommand = addArgs(
    program.command("url").description("Format a local PostgreSQL URL for a Lakebase target"),
    LakebaseProxyUrlOptionsSchema,
    { scope: [] },
  ).action(() => {
    const options = parseArgs(urlCommand, LakebaseProxyUrlOptionsSchema);
    const target = options.target ?? options.lakebaseEndpoint!;
    process.stdout.write(`${connectionUrl(target, options.listen.host, options.listen.port)}\n`);
  });
  let installCommand!: Command;
  const serviceCommand = buildServiceCommand(() => {
    return lakebaseProxyServiceDefinition(parseArgs(installCommand, LakebaseProxyOptionsSchema));
  }, dependencies.service);
  installCommand = serviceCommand.commands.find((command) => command.name() === "install")!;
  addArgs(installCommand, LakebaseProxyOptionsSchema, { scope: [] });
  program.addCommand(serviceCommand);
  return program;
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
