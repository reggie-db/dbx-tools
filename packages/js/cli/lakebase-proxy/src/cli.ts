/** Commander entry point for the pure Node Lakebase proxy. */

import { buildServiceCommand, type CliServiceCliDependencies } from "@dbx-tools/cli-service/cli";
import { defineService, type CliServiceDefinition } from "@dbx-tools/cli-service/definition";
import { connectionUrl } from "@dbx-tools/lakebase";
import { Command, InvalidArgumentError } from "commander";

import { PACKAGE_VERSION } from "../index.ts";
import { LakebaseProxy } from "./proxy.ts";

/** Injectable service boundary for Lakebase proxy CLI composition and tests. */
export interface LakebaseProxyCliDependencies {
  readonly service?: CliServiceCliDependencies;
}

/** Install-time options persisted in the Lakebase proxy service definition. */
export interface LakebaseProxyServiceOptions {
  readonly host?: string;
  readonly port?: number;
  readonly startupTimeoutSeconds?: number;
  readonly profile?: string;
}

/** Build the tray-only Lakebase proxy service definition. */
export function lakebaseProxyServiceDefinition(
  options: LakebaseProxyServiceOptions = {},
): CliServiceDefinition {
  return defineService(import.meta.url, {
    command: {
      arguments: [
        "--host",
        options.host ?? "127.0.0.1",
        "--port",
        String(options.port ?? 5432),
        "--startup-timeout-seconds",
        String(options.startupTimeoutSeconds ?? 30),
        ...(options.profile ? ["--profile", options.profile] : []),
      ],
    },
  });
}

/** Build the Lakebase proxy command-line program. */
export function buildProgram(
  name = "dbx lakebase-proxy",
  dependencies: LakebaseProxyCliDependencies = {},
): Command {
  const program = new Command(name)
    .description("Run a loopback PostgreSQL proxy for Databricks Lakebase")
    .version(PACKAGE_VERSION)
    .enablePositionalOptions()
    .option("--host <host>", "loopback listener host", "127.0.0.1")
    .option("--port <port>", "listener port", port, 5432)
    .option("--startup-timeout-seconds <seconds>", "startup timeout", integer, 30)
    .option("--profile <profile>", "exact Databricks profile")
    .action(async (options) => {
      const proxy = new LakebaseProxy({
        host: options.host,
        port: options.port,
        startupTimeoutMs: options.startupTimeoutSeconds * 1000,
        profile: options.profile,
      });
      await proxy.listen();
      await waitForShutdown();
      await proxy.close();
    });

  program
    .command("url")
    .description("Format a local PostgreSQL URL for a Lakebase target")
    .option("--target <target>", "Lakebase project, resource path, host, or URL")
    .option("--endpoint <endpoint>", "fallback target", process.env.LAKEBASE_ENDPOINT)
    .option("--host <host>", "local proxy host", "localhost")
    .option("--port <port>", "local proxy port", port, 5432)
    .action((options) => {
      const target = options.target ?? options.endpoint;
      if (!target) throw new InvalidArgumentError("url requires --target or LAKEBASE_ENDPOINT");
      process.stdout.write(`${connectionUrl(target, options.host, options.port)}\n`);
    });
  let installCommand!: Command;
  const serviceCommand = buildServiceCommand(() => {
    return lakebaseProxyServiceDefinition(installCommand.opts<LakebaseProxyServiceOptions>());
  }, dependencies.service);
  installCommand = serviceCommand.commands.find((command) => command.name() === "install")!;
  installCommand
    .option("--host <host>", "loopback listener host", "127.0.0.1")
    .option("--port <port>", "listener port", port, 5432)
    .option("--startup-timeout-seconds <seconds>", "startup timeout", integer, 30)
    .option("--profile <profile>", "exact Databricks profile");
  program.addCommand(serviceCommand);
  return program;
}

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("value must be a non-negative integer");
  }
  return parsed;
}

function port(value: string): number {
  const parsed = integer(value);
  if (parsed > 65_535) throw new InvalidArgumentError("port must not exceed 65535");
  return parsed;
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
