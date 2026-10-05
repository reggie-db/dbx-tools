/**
 * Foreground `dbx model-gateway` command.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startModelGateway } from "@dbx-tools/appkit-model-gateway";
import type { CliServiceDefinition } from "@dbx-tools/cli-service";
import { buildServiceCommand, type CliServiceCliDependencies } from "@dbx-tools/cli-service/cli";
import { json, object } from "@dbx-tools/shared-core";
import { Command, InvalidArgumentError } from "commander";

import { modelGatewayTrayIcon } from "./_tray-icon.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4400;

/** Injectable foreground gateway boundary for CLI tests. */
export interface ModelGatewayCliDependencies {
  start(options: { host?: string; port?: number; profile?: string }): Promise<void>;
  /** Optional service CLI boundary for tests and embedding. */
  readonly service?: CliServiceCliDependencies;
}

/** Install-time options persisted in the model-gateway service definition. */
export interface ModelGatewayServiceOptions {
  /** Loopback port exposed by the installed gateway. */
  readonly port?: number;
  /** Databricks profile passed to the installed gateway. */
  readonly profile?: string;
}

interface ModelGatewayCliOptions {
  host: string;
  port: number;
  profile?: string;
  runtimeInfo?: boolean;
}

const DEFAULT_DEPENDENCIES: ModelGatewayCliDependencies = {
  start: startModelGateway,
};

/** Resolve the package's foreground executable by absolute path. */
export function modelGatewayExecutable(): string {
  const manifest = fileURLToPath(import.meta.resolve("@dbx-tools/cli-model-gateway/package.json"));
  const bin = json.parseRecord(readFileSync(manifest, "utf8"))?.bin;
  const target = object.isRecord(bin) ? bin["dbx-model-gateway"] : undefined;
  if (typeof target !== "string") {
    throw new Error("could not resolve dbx-model-gateway executable");
  }
  return resolve(dirname(manifest), target);
}

/** Build the tray-only model-gateway service definition. */
export function modelGatewayServiceDefinition(
  options: ModelGatewayServiceOptions = {},
): CliServiceDefinition {
  const port = options.port ?? DEFAULT_PORT;
  parsePort(String(port));
  return {
    id: "com.dbx-tools.model-gateway",
    name: "dbx model gateway",
    version: packageVersion(),
    icon: modelGatewayTrayIcon(),
    isTemplateIcon: process.platform === "darwin",
    command: {
      entrypoint: modelGatewayExecutable(),
      arguments: [
        "--host",
        DEFAULT_HOST,
        "--port",
        String(port),
        ...(options.profile ? ["--profile", options.profile] : []),
      ],
    },
    menu: [
      {
        type: "url",
        label: "Models",
        url: `http://${DEFAULT_HOST}:${port}/v1/models`,
      },
    ],
  };
}

/** Build foreground and service model-gateway commands without starting a server. */
export function buildProgram(
  name = "dbx model-gateway",
  dependencies: ModelGatewayCliDependencies = DEFAULT_DEPENDENCIES,
): Command {
  const version = packageVersion();
  const program = new Command()
    .name(name)
    .description("Run or manage the AppKit Databricks model gateway")
    .option("--host <host>", "loopback host to bind", DEFAULT_HOST)
    .option("--port <port>", "HTTP port", parsePort, DEFAULT_PORT)
    .option("--profile <profile>", "Databricks profile resolved by @dbx-tools/auth")
    .option("--runtime-info", "print runtime implementation metadata")
    .version(version, "-v, --version")
    .action(async (options: ModelGatewayCliOptions) => {
      if (options.runtimeInfo) {
        process.stdout.write(
          `${JSON.stringify({ implementation: "typescript-appkit", version })}\n`,
        );
        return;
      }
      validateLoopbackHost(options.host);
      await dependencies.start({
        host: options.host,
        port: options.port,
        ...(options.profile ? { profile: options.profile } : {}),
      });
    });
  const serviceCommand = buildServiceCommand(() => {
    const options = program.opts<ModelGatewayServiceOptions>();
    return modelGatewayServiceDefinition(options);
  }, dependencies.service);
  program.addCommand(serviceCommand);
  return program;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError("port must be an integer from 1 through 65535");
  }
  return port;
}

function validateLoopbackHost(host: string): void {
  if (!["127.0.0.1", "::1", "localhost"].includes(host.trim().toLowerCase())) {
    throw new InvalidArgumentError("model-gateway host must be loopback");
  }
}

function packageVersion(): string {
  for (const location of [
    new URL("../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ]) {
    try {
      const version = json.parseRecord(readFileSync(location, "utf8"))?.version;
      if (typeof version === "string" && version) return version;
    } catch {
      continue;
    }
  }
  throw new Error("could not resolve @dbx-tools/cli-model-gateway version");
}
