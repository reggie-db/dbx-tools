/**
 * Supervise Genie Code and its authenticated local model gateway.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { delimiter, dirname } from "node:path";
import { DatabricksModelRegistry, models } from "@dbx-tools/appkit-model-gateway";
import * as auth from "@dbx-tools/auth";
import { resolveServicePackageBin } from "@dbx-tools/cli-service/definition";
import type { BinContext } from "@dbx-tools/core/bin";
import { workspaceClient } from "@dbx-tools/databricks";
import { log } from "@dbx-tools/shared-core";
import type { ModelClass } from "@dbx-tools/shared-model/contracts";
import {
  resolveGenieCodeOptions,
  type GenieCodeOptions,
  type GenieCodeRunnerOptions,
} from "@dbx-tools/shared-genie-code/options";
import concurrently from "concurrently";
import getPort from "get-port";

import { writeGenieCodeConfig, type GenieCodeHome } from "./config.ts";
import { installGenieCode } from "./install.ts";
import { RUNNER_OPTIONS_ENV } from "./runner.ts";

const logger = log.logger("genie-code");

/** Injectable owners used to prepare and supervise managed Genie Code. */
export interface GenieCodeRuntimeDependencies {
  createAuthClient: typeof auth.client.createAuthClient;
  install: typeof installGenieCode;
  port(options: { host: string; port?: number }): Promise<number>;
  resolveBin(packageReference: string, binName: string): string;
  resolveCodexModel(
    model: string | undefined,
    profile: string,
    modelClass?: ModelClass,
  ): Promise<string>;
  supervise: typeof concurrently;
  token(): string;
  writeConfig: typeof writeGenieCodeConfig;
}

const DEFAULT_DEPENDENCIES: GenieCodeRuntimeDependencies = {
  createAuthClient: auth.client.createAuthClient,
  install: installGenieCode,
  port: ({ host, port }) => getPort({ host, ...(port ? { port } : {}) }),
  resolveBin: resolveServicePackageBin,
  resolveCodexModel,
  supervise: concurrently,
  token: () => randomBytes(32).toString("base64url"),
  writeConfig: writeGenieCodeConfig,
};

/** Resolve a Genie `--model` value to the Codex catalogue slug the gateway publishes. */
async function resolveCodexModel(
  model: string | undefined,
  profile: string,
  modelClass?: ModelClass,
): Promise<string> {
  const client = await workspaceClient.createWorkspaceClient({ profile });
  const target = await new DatabricksModelRegistry({ client }).resolve(model, {
    requiresTools: true,
    ...(modelClass ? { modelClass } : {}),
  });
  if (!target) {
    throw new Error(
      model ? `Genie Code model not found: ${model}` : "No tool-capable chat model is available",
    );
  }
  return models.codexModelSlug(target);
}

/** Inputs accepted by managed Genie Code preparation and execution. */
export interface RunGenieCodeOptions {
  cwd?: string;
  dependencies?: Partial<GenieCodeRuntimeDependencies>;
  genieArgs?: readonly string[];
  options?: GenieCodeOptions;
}

/** Resolved installation, auth, listener, and home for one invocation. */
export interface PreparedGenieCodeRuntime {
  bearerToken: string;
  gatewayBaseUrl: string;
  gatewayHealthUrl: string;
  gatewayListen: string;
  gatewayPort: number;
  home: GenieCodeHome;
  installation: BinContext;
  model: string;
  profile: string;
}

/** Resolve auth, installation, listener, and configuration before spawning children. */
export async function prepareGenieCodeRuntime(
  input: RunGenieCodeOptions = {},
): Promise<PreparedGenieCodeRuntime> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies };
  const options = resolveGenieCodeOptions(input.options);
  logger.info("resolving Databricks authentication", {
    requestedProfile: options.profile,
  });
  const authClient = await dependencies.createAuthClient(
    options.profile ? { profile: options.profile } : {},
  );
  const profile = authClient.profile;
  if (!profile) {
    throw new Error("Genie Code requires a configured Databricks profile");
  }
  logger.info("preparing Genie Code runtime", {
    profile,
    model: options.model,
    modelClass: options.modelClass,
  });
  const installation = await dependencies.install();
  const host = options.gatewayListen.host;
  const requestedPort = options.gatewayListen.port;
  const gatewayPort = await dependencies.port({
    host,
    ...(requestedPort > 0 ? { port: requestedPort } : {}),
  });
  if (requestedPort > 0 && gatewayPort !== requestedPort) {
    throw new Error(`Genie Code gateway port ${requestedPort} is already in use`);
  }
  const model = await dependencies.resolveCodexModel(options.model, profile, options.modelClass);
  logger.info("resolved Genie Code model", {
    requested: options.model,
    modelClass: options.modelClass,
    model,
  });
  const urlHost = host.includes(":") ? `[${host}]` : host;
  const gatewayBaseUrl = `http://${urlHost}:${gatewayPort}/v1`;
  const gatewayHealthUrl = `http://${urlHost}:${gatewayPort}/api/healthz`;
  const gatewayListen = `tcp://${urlHost}:${gatewayPort}`;
  const bearerToken = dependencies.token();
  const home = await dependencies.writeConfig({
    bearerToken,
    gatewayBaseUrl,
    model,
    profile,
    projectDirectory: input.cwd ?? process.cwd(),
  });
  return {
    bearerToken,
    gatewayBaseUrl,
    gatewayHealthUrl,
    gatewayListen,
    gatewayPort,
    home,
    installation,
    model,
    profile,
  };
}

function shellExecutable(path: string): string {
  if (process.platform === "win32") return `"${path.replaceAll('"', '""')}"`;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function childPath(...paths: string[]): string {
  return [...new Set([...paths.map(dirname), process.env.PATH].filter(Boolean))].join(delimiter);
}

/** Run Genie Code and the model gateway until either process exits. */
export async function runGenieCode(input: RunGenieCodeOptions = {}): Promise<void> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies };
  const prepared = await prepareGenieCodeRuntime({
    ...input,
    dependencies,
  });
  const gatewayBin = dependencies.resolveBin(import.meta.url, "dbx-model-gateway");
  const runnerBin = dependencies.resolveBin(import.meta.url, "dbx-genie");
  const path = childPath(gatewayBin, runnerBin);
  const runnerOptions: GenieCodeRunnerOptions = {
    executable: prepared.installation.path,
    arguments: ["-p", prepared.home.overlayName, ...(input.genieArgs ?? [])],
    home: prepared.home.home,
    gatewayHealthUrl: prepared.gatewayHealthUrl,
    bearerToken: prepared.bearerToken,
    startupTimeoutMs: 60_000,
  };
  const { result } = dependencies.supervise(
    [
      {
        command: shellExecutable(gatewayBin),
        name: "gateway",
        env: {
          ...process.env,
          PATH: path,
          LISTEN: prepared.gatewayListen,
          DATABRICKS_CONFIG_PROFILE: prepared.profile,
          DBX_TOOLS_MODEL_GATEWAY_BEARER_TOKEN: prepared.bearerToken,
        },
      },
      {
        command: shellExecutable(runnerBin),
        name: "genie",
        env: {
          ...process.env,
          PATH: path,
          DATABRICKS_CONFIG_PROFILE: prepared.profile,
          [RUNNER_OPTIONS_ENV]: JSON.stringify(runnerOptions),
        },
      },
    ],
    {
      cwd: input.cwd ?? process.cwd(),
      raw: true,
      killOthersOn: ["failure", "success"],
      killSignal: "SIGTERM",
      killTimeout: 17_000,
      successCondition: "command-genie",
    },
  );
  logger.info("started Genie Code and model gateway", {
    profile: prepared.profile,
    model: prepared.model,
    gateway: prepared.gatewayBaseUrl,
    home: prepared.home.home,
  });
  try {
    await result;
  } finally {
    await rm(prepared.home.overlayPath, { force: true });
  }
}
