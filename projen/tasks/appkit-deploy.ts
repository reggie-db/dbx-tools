#!/usr/bin/env -S bun
/** Deploy an AppKit workspace through npm-compatible temporary manifests. */
import { profile } from "@dbx-tools/auth";
import * as exec from "@dbx-tools/core/exec";
import { runTaskMain } from "./cli.ts";
import { withStagedWorkspaceManifests } from "../src/workspace-manifest.ts";

/** Effects accepted by the AppKit deploy task for focused tests. */
export interface AppKitDeployDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly root?: string;
  readonly resolveProfile?: () => string | undefined;
  readonly run?: (args: readonly string[], cwd: string) => Promise<{ readonly exitCode: number }>;
}

/** Run Databricks Apps deploy while generated workspace manifests are materialized. */
export async function deployApp(
  args: readonly string[],
  dependencies: AppKitDeployDependencies = {},
): Promise<void> {
  const root = dependencies.root ?? process.cwd();
  const deployArgs = resolveDeployArgs(args, dependencies);
  const run =
    dependencies.run ??
    ((deployArgs: readonly string[], cwd: string) =>
      exec.spawn("databricks", ["apps", "deploy", ...deployArgs], {
        cwd,
        env: dependencies.environment ?? process.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }));
  await withStagedWorkspaceManifests(root, async (stage) => {
    const result = await run(deployArgs, stage);
    if (result.exitCode !== 0) {
      throw new Error(`databricks apps deploy exited with code ${result.exitCode}`);
    }
  });
}

function resolveDeployArgs(
  args: readonly string[],
  dependencies: AppKitDeployDependencies,
): readonly string[] {
  const environment = dependencies.environment ?? process.env;
  const hasProfile = args.some(
    (argument) =>
      argument === "--profile" || argument === "-p" || argument.startsWith("--profile="),
  );
  const hasEnvironmentAuth =
    Boolean(environment.DATABRICKS_HOST) &&
    (Boolean(environment.DATABRICKS_TOKEN) ||
      (Boolean(environment.DATABRICKS_CLIENT_ID) && Boolean(environment.DATABRICKS_CLIENT_SECRET)));
  const resolvedProfile =
    hasProfile || hasEnvironmentAuth
      ? undefined
      : (dependencies.resolveProfile ?? (() => profile.resolveProfile()?.name))();
  if (!hasProfile && !hasEnvironmentAuth && !resolvedProfile) {
    throw new Error(
      "Select a Databricks profile with --profile or configure Databricks environment credentials",
    );
  }
  return [
    ...(args.includes("--skip-validation") ? [] : ["--skip-validation"]),
    ...args,
    ...(resolvedProfile ? ["--profile", resolvedProfile] : []),
  ];
}

await runTaskMain(import.meta, () => deployApp(process.argv.slice(2)));
