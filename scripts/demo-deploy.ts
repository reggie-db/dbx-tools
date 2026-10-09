#!/usr/bin/env bun
/**
 * Stage the AppKit demo app outside the repo and deploy it with the bundle.
 *
 * Compile current workspace artifacts, materialize a self-contained tree, then
 * resolve the target host's profile through `@dbx-tools/auth` before running
 * `bundle deploy` and `bundle run demo_app`.
 */
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { client as authClient, profile as authProfile } from "@dbx-tools/auth";
import { log } from "@dbx-tools/shared-core";
import { parse } from "yaml";

const logger = log.logger("demo:deploy");
const ROOT = process.cwd();
const SERVER_DIR = path.join(ROOT, "packages/example/server/appkit-demo");
const STAGE_DIR = path.join(tmpdir(), "dbx-tools-deploy-app");

interface BundleTarget {
  default?: boolean;
}

interface BundleConfig {
  targets?: Record<string, BundleTarget>;
}

function bundleTarget(config: BundleConfig): { name: string; target: BundleTarget } {
  const targets = Object.entries(config.targets ?? {});
  const requested = process.env.DATABRICKS_BUNDLE_TARGET?.trim();
  if (requested) {
    const target = config.targets?.[requested];
    if (!target) throw new Error(`Databricks bundle target ${requested} does not exist`);
    return { name: requested, target };
  }
  const defaults = targets.filter(([, target]) => target.default === true);
  if (defaults.length === 1) return { name: defaults[0]![0], target: defaults[0]![1] };
  if (targets.length === 1) return { name: targets[0]![0], target: targets[0]![1] };
  throw new Error("Databricks bundle must declare one default target or DATABRICKS_BUNDLE_TARGET");
}

async function deploymentAuth(): Promise<{ host: string; profile: string; target: string }> {
  const config = parse(
    readFileSync(path.join(STAGE_DIR, "databricks.yml"), "utf8"),
  ) as BundleConfig;
  const selected = bundleTarget(config);
  const resolved = authProfile.resolveProfile();
  if (!resolved?.host) {
    throw new Error("No configured/default Databricks workspace profile with a host was found");
  }
  const client = await authClient.createAuthClient({ profile: resolved.name });
  await client.token({ login: true, refresh: true });
  return { host: resolved.host, profile: resolved.name, target: selected.name };
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with code ${exitCode}`);
  }
}

async function main(): Promise<void> {
  logger.info("compiling demo client");
  await run([process.execPath, "run", "--filter", "@dbx-tools/demo-appkit-app", "compile"], ROOT);
  logger.info("compiling workspace packages for local deployment");
  await run([process.execPath, "run", "compile"], ROOT);
  logger.info("staging deploy tree");
  await run([process.execPath, "stage-deploy.ts"], SERVER_DIR);
  const auth = await deploymentAuth();
  logger.info("deploying demo app", { ...auth, stageDir: STAGE_DIR });
  const selection = ["-t", auth.target, "--profile", auth.profile];
  await run(["databricks", "bundle", "validate", ...selection], STAGE_DIR);
  await run(["databricks", "bundle", "deploy", "--auto-approve", ...selection], STAGE_DIR);
  await run(["databricks", "bundle", "run", "demo_app", ...selection], STAGE_DIR);
  logger.info("demo app deployed");
}

await main();
