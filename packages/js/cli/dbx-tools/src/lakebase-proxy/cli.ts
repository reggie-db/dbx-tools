/** Commander entry point for the pure Node Lakebase proxy. */

import { addArgs, parseArgs, serializeArgs } from "@dbx-tools/cli-args";
import {
  buildServiceCommand,
  type CliServiceCliDependencies,
  defineService,
  type CliServiceDefinition,
  type CliServiceInstallOptions,
} from "@dbx-tools/cli-service";
import { serviceTrayIcon } from "@dbx-tools/cli-service";
import { connectionUrl } from "@dbx-tools/lakebase";
import { Command } from "commander";

import {
  LakebaseProxyOptionsSchema,
  LakebaseProxyUrlOptionsSchema,
  resolveLakebaseProxyOptions,
  type LakebaseProxyOptions,
} from "./options.ts";
import { LakebaseProxy } from "./proxy.ts";
import { PACKAGE_VERSION } from "../../index.ts";
import { databricksServiceAuthCommand } from "../service-auth.ts";

/** Injectable service boundary for Lakebase proxy CLI composition and tests. */
export interface LakebaseProxyCliDependencies {
  readonly service?: CliServiceCliDependencies;
}

/** Build the tray-only Lakebase proxy service definition. */
export function lakebaseProxyServiceDefinition(
  options: LakebaseProxyOptions = {},
  serviceOptions: Pick<CliServiceInstallOptions, "waitForAuth"> = {},
): CliServiceDefinition {
  const resolved = resolveLakebaseProxyOptions(options);
  const waitForAuth = serviceOptions.waitForAuth ?? "auto";
  return defineService(import.meta.url, {
    id: "dbx-tools.cli-lakebase-proxy",
    name: "dbx lakebase proxy",
    icon: serviceTrayIcon("lakebase"),
    waitForAuth,
    authCommand: databricksServiceAuthCommand(waitForAuth, resolved.profile),
    command: {
      binName: "dbx-lakebase-proxy",
      arguments: serializeArgs(resolved),
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
  ).action(async () => {
    const proxy = new LakebaseProxy(parseArgs(program, LakebaseProxyOptionsSchema));
    await proxy.listen();
    await waitForShutdown();
    await proxy.close();
  });

  const urlCommand = addArgs(
    program.command("url").description("Format a local PostgreSQL URL for a Lakebase target"),
    LakebaseProxyUrlOptionsSchema,
  ).action(() => {
    const options = parseArgs(urlCommand, LakebaseProxyUrlOptionsSchema);
    const target = options.target ?? options.lakebaseEndpoint!;
    process.stdout.write(`${connectionUrl(target, options.listen.host, options.listen.port)}\n`);
  });
  let installCommand!: Command;
  const serviceCommand = buildServiceCommand((serviceOptions) => {
    return lakebaseProxyServiceDefinition(
      parseArgs(installCommand, LakebaseProxyOptionsSchema),
      serviceOptions,
    );
  }, dependencies.service);
  installCommand = serviceCommand.commands.find((command) => command.name() === "install")!;
  addArgs(installCommand, LakebaseProxyOptionsSchema);
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
