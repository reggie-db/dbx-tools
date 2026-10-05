/**
 * Foreground `dbx model-gateway` command.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startModelGateway } from "@dbx-tools/appkit-model-gateway";
import { json } from "@dbx-tools/shared-core";
import { Command, InvalidArgumentError } from "commander";

/** Injectable foreground gateway boundary for CLI tests. */
export interface ModelGatewayCliDependencies {
  start(options: { host?: string; port?: number; profile?: string }): Promise<void>;
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
  return join(dirname(manifest), "bin", "dbx-model-gateway.ts");
}

/** Build the foreground model-gateway command without starting a server. */
export function buildProgram(
  name = "dbx model-gateway",
  dependencies: ModelGatewayCliDependencies = DEFAULT_DEPENDENCIES,
): Command {
  const version = packageVersion();
  return new Command()
    .name(name)
    .description("Run the foreground AppKit Databricks model gateway")
    .option("--host <host>", "loopback host to bind", "127.0.0.1")
    .option("--port <port>", "HTTP port", parsePort, 4400)
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
