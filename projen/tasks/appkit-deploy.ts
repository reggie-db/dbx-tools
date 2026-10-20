#!/usr/bin/env -S bun
/** Deploy an AppKit workspace through npm-compatible temporary manifests. */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveProfile } from "@dbx-tools/auth";
import { serializeArgs } from "@dbx-tools/cli-args";
import { spawn, spawnSync } from "@dbx-tools/core";
import { log, toError } from "@dbx-tools/shared-core";
import { z } from "zod";
import { runTaskMain, taskCommand, taskOptions } from "./cli.ts";
import { withStagedWorkspaceManifests } from "../src/workspace-manifest.ts";

const logger = log.logger("projen:appkit-deploy");

export const AppKitDeployContextOptionsSchema = z.object({
  target: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Databricks bundle target")
    .meta({ env: [], short: "t" }),
  profile: z.string().trim().min(1).optional().describe("Databricks CLI profile").meta({
    env: [],
    helpDefault: false,
    short: "p",
  }),
  var: z
    .array(z.string().trim().min(1))
    .default([])
    .describe("Databricks bundle variable assignment")
    .meta({ env: [] }),
});

export const AppKitDeployOptionsSchema = AppKitDeployContextOptionsSchema.extend({
  autoApprove: z
    .boolean()
    .default(false)
    .describe("Skip interactive deployment approval")
    .meta({ env: [] }),
  failOnActiveRuns: z
    .boolean()
    .default(true)
    .describe("Fail when bundle jobs or pipelines are active")
    .meta({ env: [] }),
  skipTests: z
    .boolean()
    .default(true)
    .describe("Skip Databricks CLI tests after the Bun validation")
    .meta({ env: [] }),
  skipValidation: z
    .boolean()
    .default(true)
    .describe("Skip Databricks CLI npm validation after the Bun validation")
    .meta({ env: [] }),
});

export type AppKitDeployOptions = z.output<typeof AppKitDeployOptionsSchema>;

interface DeployCommandResult {
  readonly exitCode: number;
  readonly stderr?: string;
  readonly stdout?: string;
}

/** Effects accepted by the AppKit deploy task for focused tests. */
export interface AppKitDeployDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly logs?: (args: readonly string[], cwd: string) => Promise<DeployCommandResult>;
  readonly plan?: (args: readonly string[], cwd: string) => Promise<DeployCommandResult>;
  readonly root?: string;
  readonly resolveProfile?: () => string | undefined;
  readonly run?: (args: readonly string[], cwd: string) => Promise<DeployCommandResult>;
  readonly validate?: (args: readonly string[], cwd: string) => Promise<DeployCommandResult>;
}

/** Run Databricks Apps deploy while generated workspace manifests are materialized. */
export async function deployApp(
  args: readonly string[],
  dependencies: AppKitDeployDependencies = {},
): Promise<void> {
  const root = dependencies.root ?? process.cwd();
  const options = await resolveDeployOptions(args, dependencies);
  const context = AppKitDeployContextOptionsSchema.parse({
    target: options.target,
    profile: options.profile,
    var: options.var,
  });
  const contextArgs = serializeArgs(context);
  const deployArgs = serializeArgs({
    ...context,
    ...(options.autoApprove ? { autoApprove: true } : {}),
    ...(options.failOnActiveRuns ? { failOnActiveRuns: true } : {}),
    ...(options.skipTests ? { skipTests: true } : {}),
    ...(options.skipValidation ? { skipValidation: true } : {}),
  });
  const validate =
    dependencies.validate ??
    (dependencies.run
      ? undefined
      : (validateArgs: readonly string[], cwd: string) =>
          spawn(
            "databricks",
            ["bundle", "validate", ...serializeArgs({ strict: true }), ...validateArgs],
            {
              cwd,
              env: dependencies.environment ?? process.env,
              stdin: "ignore",
              stdout: "inherit",
              stderr: "inherit",
            },
          ));
  if (validate) {
    const validation = await validate(contextArgs, root);
    if (validation.exitCode !== 0) {
      throw new Error(`databricks bundle validate exited with code ${validation.exitCode}`);
    }
  }
  const run =
    dependencies.run ??
    ((deployArgs: readonly string[], cwd: string) =>
      spawn("databricks", ["apps", "deploy", ...deployArgs], {
        cwd,
        env: dependencies.environment ?? process.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }));
  await withStagedWorkspaceManifests(root, async (stage) => {
    await reconcileStagedBundleState(stage, contextArgs, options.target, dependencies);
    const result = await run(deployArgs, stage);
    if (result.exitCode !== 0) {
      await printAppLogs(contextArgs, stage, dependencies);
      throw new Error(`databricks apps deploy exited with code ${result.exitCode}`);
    }
  });
}

async function reconcileStagedBundleState(
  stage: string,
  contextArgs: readonly string[],
  target: string | undefined,
  dependencies: AppKitDeployDependencies,
): Promise<void> {
  const plan =
    dependencies.plan ??
    (dependencies.run
      ? undefined
      : (args: readonly string[], cwd: string) =>
          Promise.resolve(
            spawnSync(
              "databricks",
              ["bundle", "plan", ...serializeArgs({ quiet: true }), ...args],
              {
                cwd,
                env: dependencies.environment ?? process.env,
                stdin: "ignore",
                stdout: "capture",
                stderr: "capture",
              },
            ),
          ));
  if (!plan) return;
  const result = await plan(contextArgs, stage);
  if (result.exitCode === 0) return;
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.toLowerCase();
  if (
    !output.includes("lineage mismatch in state files") ||
    !output.includes("remote direct state")
  ) {
    return;
  }
  if (!target) return;
  const state = join(stage, ".databricks", "bundle", target, "resources.json");
  if (!existsSync(state)) return;
  rmSync(state);
  logger.warn("Removed stale staged bundle state", { target });
}

async function printAppLogs(
  contextArgs: readonly string[],
  cwd: string,
  dependencies: AppKitDeployDependencies,
): Promise<void> {
  logger.error("Databricks Apps deployment failed; recent app logs follow");
  const showLogs =
    dependencies.logs ??
    ((args: readonly string[], logsCwd: string) =>
      spawn("databricks", ["apps", "logs", ...serializeArgs({ tailLines: 200 }), ...args], {
        cwd: logsCwd,
        env: dependencies.environment ?? process.env,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      }));
  try {
    const result = await showLogs(contextArgs, cwd);
    if (result.exitCode !== 0) {
      logger.warn("Could not read Databricks App logs", { exitCode: result.exitCode });
    }
  } catch (error) {
    logger.warn("Could not read Databricks App logs", {
      message: toError(error).message,
    });
  }
}

async function resolveDeployOptions(
  args: readonly string[],
  dependencies: AppKitDeployDependencies,
): Promise<AppKitDeployOptions> {
  const parsed = await taskOptions(
    taskCommand(
      import.meta.url,
      "Validate and deploy an AppKit workspace through Databricks Apps",
      AppKitDeployOptionsSchema,
    ),
    AppKitDeployOptionsSchema,
    args,
  );
  const environment = dependencies.environment ?? process.env;
  const hasEnvironmentAuth =
    Boolean(environment.DATABRICKS_HOST) &&
    (Boolean(environment.DATABRICKS_TOKEN) ||
      (Boolean(environment.DATABRICKS_CLIENT_ID) && Boolean(environment.DATABRICKS_CLIENT_SECRET)));
  const configuredProfile = environment.DATABRICKS_CONFIG_PROFILE ?? environment.DATABRICKS_PROFILE;
  const resolvedProfile =
    parsed.profile ??
    configuredProfile ??
    (hasEnvironmentAuth
      ? undefined
      : (dependencies.resolveProfile ?? (() => resolveProfile()?.name))());
  if (!hasEnvironmentAuth && !resolvedProfile) {
    throw new Error(
      "Select a Databricks profile with --profile or configure Databricks environment credentials",
    );
  }
  return AppKitDeployOptionsSchema.parse({
    ...parsed,
    target: parsed.target ?? environment.DATABRICKS_BUNDLE_TARGET,
    profile: resolvedProfile,
  });
}

await runTaskMain(import.meta, () => deployApp(process.argv.slice(2)));
