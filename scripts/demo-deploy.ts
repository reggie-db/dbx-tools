#!/usr/bin/env bun
/**
 * Stage the AppKit demo app outside the repo and deploy it with the bundle.
 *
 * Matches the documented FEVM flow: compile the client, materialize a
 * self-contained tree, then `bundle deploy` + `bundle run demo_app` with the
 * profile pinned on the demo target.
 */
import { tmpdir } from "node:os";
import path from "node:path";
import { log } from "@dbx-tools/shared-core";

const logger = log.logger("demo:deploy");
const ROOT = process.cwd();
const SERVER_DIR = path.join(ROOT, "packages/example/server/appkit-demo");
const STAGE_DIR = path.join(tmpdir(), "dbx-tools-deploy-app");
/** Profile declared on the demo bundle target; pass it explicitly so a shell DATABRICKS_CONFIG_PROFILE cannot retarget the deploy. */
const PROFILE = "FEVM-REGGIE-PIERCE-AWS";

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
  logger.info("staging deploy tree");
  await run([process.execPath, "stage-deploy.ts"], SERVER_DIR);
  logger.info("deploying demo app", { profile: PROFILE, stageDir: STAGE_DIR });
  await run(["databricks", "bundle", "validate", "--profile", PROFILE], STAGE_DIR);
  await run(["databricks", "bundle", "deploy", "--auto-approve", "--profile", PROFILE], STAGE_DIR);
  await run(["databricks", "bundle", "run", "demo_app", "--profile", PROFILE], STAGE_DIR);
  logger.info("demo app deployed");
}

await main();
