#!/usr/bin/env bun
/// <reference types="bun" />
/** Deploy the demo through the Projen-owned AppKit deployment task. */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  applyLakebaseProvisionTargets,
  resolveLakebaseProvisionTargets,
} from "@dbx-tools/appkit";
import { agentStorageSchemaName } from "@dbx-tools/appkit-mastra";
import { createAuthClient } from "@dbx-tools/auth";
import { parseArgv } from "@dbx-tools/cli-args";
import { spawn } from "@dbx-tools/core";
import { LakebaseClient, parseAddress } from "@dbx-tools/lakebase";
import { log, toError } from "@dbx-tools/shared-core";
import { Client } from "pg";
import { parse } from "yaml";
import { z } from "zod";

import { DEMO_AGENT_IDS } from "../packages/demo/shared/agent-ids.ts";

const logger = log.logger("demo:deploy");
const ROOT = process.cwd();
const APP_DIR = path.join(ROOT, "packages/demo");

const BundleTargetSchema = z.object({
  default: z.boolean().optional(),
});

const BundleConfigSchema = z.object({
  targets: z.record(z.string(), BundleTargetSchema).optional(),
  variables: z.object({
    app_name: z.object({ default: z.string() }),
    generator_catalog: z.object({ default: z.string() }),
    lakebase_project_id: z.object({ default: z.string() }),
  }),
});

const AppResponseSchema = z.object({
  service_principal_client_id: z.string().uuid(),
});

export const DEMO_AGENT_STORAGE_SCHEMAS = Object.values(DEMO_AGENT_IDS).map(
  agentStorageSchemaName,
);

export const DemoDeployOptionsSchema = z.object({
  profile: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Databricks CLI profile override")
    .meta({ env: [], short: false }),
  validation: z
    .boolean()
    .default(true)
    .describe("Run the repository check before deployment")
    .meta({ env: [], short: false }),
});

function bundleTarget(config: z.infer<typeof BundleConfigSchema>): string {
  const targets = Object.entries(config.targets ?? {});
  const requested = process.env.DATABRICKS_BUNDLE_TARGET?.trim();
  if (requested) {
    if (!config.targets?.[requested]) {
      throw new Error(`Databricks bundle target ${requested} does not exist`);
    }
    return requested;
  }
  const defaults = targets.filter(([, target]) => target.default === true);
  if (defaults.length === 1) return defaults[0]![0];
  if (targets.length === 1) return targets[0]![0];
  throw new Error("Databricks bundle must declare one default target or DATABRICKS_BUNDLE_TARGET");
}

async function run(command: string[], cwd: string): Promise<void> {
  const result = await spawn(command[0]!, command.slice(1), {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with code ${result.exitCode}`);
  }
}

async function runOutput(command: string[], cwd: string): Promise<string> {
  const result = await spawn(command[0]!, command.slice(1), {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "capture",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with code ${result.exitCode}`);
  }
  return result.stdout;
}

async function appServicePrincipalClientId(
  appName: string,
  selection: string[],
): Promise<string> {
  return AppResponseSchema.parse(
    JSON.parse(
      await runOutput(
        ["databricks", "apps", "get", appName, "--output", "json", ...selection],
        APP_DIR,
      ),
    ),
  ).service_principal_client_id;
}

async function grantGeneratorCatalog(
  servicePrincipalClientId: string,
  generatorCatalog: string,
  selection: string[],
): Promise<void> {
  await run(
    [
      "databricks",
      "grants",
      "update",
      "catalog",
      generatorCatalog,
      "--json",
      JSON.stringify({
        changes: [
          {
            principal: servicePrincipalClientId,
            add: ["USE_CATALOG", "CREATE_SCHEMA"],
          },
        ],
      }),
      ...selection,
    ],
    APP_DIR,
  );
}

async function grantLakebaseSchemas(
  servicePrincipalClientId: string,
  target: string,
  profile: string | undefined,
): Promise<void> {
  const lakebase = new LakebaseClient(profile ? { profile } : {});
  const resolved = await lakebase.resolve(parseAddress(target));
  const password = await lakebase.generateDatabaseCredential(resolved.endpoint);
  const client = new Client({
    host: resolved.host,
    port: resolved.port,
    database: resolved.database,
    user: resolved.user,
    password,
    ssl: { rejectUnauthorized: true },
  });
  try {
    await client.connect();
    await applyLakebaseProvisionTargets(
      client,
      servicePrincipalClientId,
      resolveLakebaseProvisionTargets(DEMO_AGENT_STORAGE_SCHEMAS),
      logger,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgv(DemoDeployOptionsSchema, argv);
  const config = BundleConfigSchema.parse(
    parse(readFileSync(path.join(APP_DIR, "databricks.yml"), "utf8")),
  );
  const target = bundleTarget(config);
  const client = await createAuthClient(options);
  await client.token({ login: true, refresh: true });
  const selection = ["--target", target, ...(client.profile ? ["--profile", client.profile] : [])];

  if (options.validation) await run([process.execPath, "run", "check"], ROOT);
  await run(
    [
      process.execPath,
      "node_modules/@dbx-tools/projen/tasks/appkit-deploy.ts",
      "--directory",
      "packages/demo",
      ...selection,
    ],
    ROOT,
  );
  const servicePrincipalClientId = await appServicePrincipalClientId(
    config.variables.app_name.default,
    selection,
  );
  await grantGeneratorCatalog(
    servicePrincipalClientId,
    config.variables.generator_catalog.default,
    selection,
  );
  await grantLakebaseSchemas(
    servicePrincipalClientId,
    config.variables.lakebase_project_id.default,
    client.profile,
  );
  logger.info("demo app deployed", { profile: client.profile, target });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    logger.error(toError(error));
    process.exitCode = 1;
  }
}
