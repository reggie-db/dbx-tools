/** Commander entry point for the pure Node Lakebase proxy. */

import { readFileSync } from "node:fs";
import { connectionUrl } from "@dbx-tools/lakebase";
import { json } from "@dbx-tools/shared-core";
import { Command, InvalidArgumentError } from "commander";

import { LakebaseProxy } from "./proxy.ts";

export function buildProgram(name = "dbx lakebase-proxy"): Command {
  const program = new Command(name)
    .description("Run a loopback PostgreSQL proxy for Databricks Lakebase")
    .version(packageVersion())
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
  throw new Error("could not resolve @dbx-tools/cli-lakebase-proxy version");
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
