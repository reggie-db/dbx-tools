#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * Stage the AppKit demo app outside the repo and deploy it with the bundle.
 *
 * Compile current workspace artifacts, materialize a self-contained tree, then
 * pass an optional profile override directly to
 * `@dbx-tools/auth` before running `bundle deploy` and `bundle run demo_app`.
 */
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createAuthClient } from "@dbx-tools/auth";
import { parseArgv } from "@dbx-tools/cli-args";
import { spawn, onParentTerminationSignal } from "@dbx-tools/core";
import { log, sleep, toError } from "@dbx-tools/shared-core";
import { parse } from "yaml";
import { z } from "zod";

const logger = log.logger("demo:deploy");
const DEPLOY_RETRY_DELAY_MS = 15_000;
const DEPLOY_ATTEMPTS = 2;
const PERMISSION_DEADLINE_ERROR =
  /failed to grant permissions for (?:SP|service principal) [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} on database projects\/[^/\s]+\/branches\/[^/\s]+\/databases\/[^:\s]+:\s*deadline exceeded after \d+ns/i;
const ROOT = process.cwd();
const SERVER_DIR = path.join(ROOT, "packages/example/server/appkit-demo");
const STAGE_DIR = path.join(tmpdir(), "dbx-tools-deploy-app");

const BundleTargetSchema = z.object({
  default: z.boolean().optional(),
});
type BundleTarget = z.infer<typeof BundleTargetSchema>;

const BundleConfigSchema = z.object({
  targets: z.record(z.string(), BundleTargetSchema).optional(),
  variables: z.object({
    app_name: z.object({ default: z.string() }),
    generator_catalog: z.object({ default: z.string() }),
  }),
});
type BundleConfig = z.infer<typeof BundleConfigSchema>;

const AppResponseSchema = z.object({
  service_principal_client_id: z.string().uuid(),
});

const DemoDeployOptionsSchema = z.object({
  profile: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Databricks CLI profile override")
    .meta({ env: [], short: false }),
});
type DemoDeployOptions = z.output<typeof DemoDeployOptionsSchema>;

/** Result surface needed to classify a bundle deployment attempt. */
export interface DeployCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable effects used by the bounded deployment retry. */
export interface DeployRetryDependencies {
  readonly run?: () => Promise<DeployCommandResult>;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}

/** Injectable commands used to run the deployed demo and retrieve failure logs. */
export interface DemoAppRunDependencies {
  readonly logs?: () => Promise<void>;
  readonly run?: () => Promise<void>;
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

async function deploymentAuth(options: DemoDeployOptions): Promise<{
  host: string;
  profile?: string;
  target: string;
  appName: string;
  generatorCatalog: string;
}> {
  const config = BundleConfigSchema.parse(
    parse(readFileSync(path.join(STAGE_DIR, "databricks.yml"), "utf8")),
  );
  const selected = bundleTarget(config);
  const client = await createAuthClient(options);
  await client.token({ login: true, refresh: true });
  return {
    host: client.host,
    ...(client.profile ? { profile: client.profile } : {}),
    target: selected.name,
    appName: config.variables.app_name.default,
    generatorCatalog: config.variables.generator_catalog.default,
  };
}

function commandError(command: readonly string[], exitCode: number): Error {
  return new Error(`${command.join(" ")} exited with code ${exitCode}`);
}

async function run(command: string[], cwd: string): Promise<void> {
  const result = await spawn(command[0]!, command.slice(1), {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw commandError(command, result.exitCode);
}

async function runOutput(command: string[], cwd: string): Promise<string> {
  const result = await spawn(command[0]!, command.slice(1), {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "capture",
    stderr: { onLine: (line) => logger.info(line), capture: true },
  });
  if (result.exitCode !== 0) throw commandError(command, result.exitCode);
  return result.stdout;
}

async function runObserved(command: string[], cwd: string): Promise<DeployCommandResult> {
  return spawn(command[0]!, command.slice(1), {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: { onLine: (line) => logger.info(line), capture: true },
    stderr: { onLine: (line) => logger.info(line), capture: true },
  });
}

/** Whether a failed bundle deploy is the known transient database grant deadline. */
export function isPermissionDeadlineFailure(result: DeployCommandResult): boolean {
  if (result.exitCode === 0) return false;
  return PERMISSION_DEADLINE_ERROR.test(`${result.stdout}\n${result.stderr}`);
}

/**
 * Run one convergent bundle deployment with one bounded retry for the known
 * App permission reconciliation timeout.
 */
export async function deployBundleWithRetry(
  command: string[],
  cwd: string,
  dependencies: DeployRetryDependencies = {},
): Promise<void> {
  const runAttempt = dependencies.run ?? (() => runObserved(command, cwd));
  const wait = dependencies.sleep ?? sleep;
  for (let attempt = 1; attempt <= DEPLOY_ATTEMPTS; attempt++) {
    const result = await runAttempt();
    if (result.exitCode === 0) return;
    if (attempt === DEPLOY_ATTEMPTS || !isPermissionDeadlineFailure(result)) {
      throw commandError(command, result.exitCode);
    }
    logger.warn("Databricks database permission reconciliation timed out; retrying deploy", {
      attempt,
      delayMs: DEPLOY_RETRY_DELAY_MS,
    });
    await wait(DEPLOY_RETRY_DELAY_MS, dependencies.signal);
  }
}

/** Run the deployed app resource and print current app logs before preserving a failure. */
export async function runDemoApp(
  appName: string,
  selection: string[],
  cwd: string,
  dependencies: DemoAppRunDependencies = {},
): Promise<void> {
  const runApp =
    dependencies.run ?? (() => run(["databricks", "bundle", "run", "demo_app", ...selection], cwd));
  const showLogs = dependencies.logs ?? (() => printAppLogs(appName, selection, cwd));
  try {
    await runApp();
  } catch (error) {
    try {
      await showLogs();
    } catch (logsError) {
      logger.warn("Could not read Databricks App logs", {
        message: toError(logsError).message,
      });
    }
    throw error;
  }
}

async function printAppLogs(appName: string, selection: string[], cwd: string): Promise<void> {
  logger.error("Databricks App failed to start; recent app logs follow", { appName });
  const result = await spawn(
    "databricks",
    ["apps", "logs", appName, "--tail-lines", "200", ...selection],
    {
      cwd,
      env: process.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (result.exitCode !== 0) {
    logger.warn("Could not read Databricks App logs", { exitCode: result.exitCode });
  }
}

async function grantGeneratorCatalog(
  auth: Awaited<ReturnType<typeof deploymentAuth>>,
  selection: string[],
): Promise<void> {
  const app = AppResponseSchema.parse(
    JSON.parse(
      await runOutput(
        ["databricks", "apps", "get", auth.appName, "--output", "json", ...selection],
        STAGE_DIR,
      ),
    ),
  );
  await run(
    [
      "databricks",
      "grants",
      "update",
      "catalog",
      auth.generatorCatalog,
      "--json",
      JSON.stringify({
        changes: [
          {
            principal: app.service_principal_client_id,
            add: ["USE_CATALOG", "CREATE_SCHEMA"],
          },
        ],
      }),
      ...selection,
    ],
    STAGE_DIR,
  );
}

export async function main(
  signal?: AbortSignal,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseArgv(DemoDeployOptionsSchema, argv);
  logger.info("compiling demo client");
  await run([process.execPath, "run", "--filter", "@dbx-tools/demo-appkit-app", "compile"], ROOT);
  logger.info("compiling workspace packages for local deployment");
  await run([process.execPath, "run", "compile"], ROOT);
  logger.info("staging deploy tree");
  await run([process.execPath, "stage-deploy.ts"], SERVER_DIR);
  const auth = await deploymentAuth(options);
  logger.info("deploying demo app", { ...auth, stageDir: STAGE_DIR });
  const selection = ["-t", auth.target, ...(auth.profile ? ["--profile", auth.profile] : [])];
  await run(["databricks", "bundle", "validate", ...selection], STAGE_DIR);
  await deployBundleWithRetry(
    ["databricks", "bundle", "deploy", "--auto-approve", ...selection],
    STAGE_DIR,
    { signal },
  );
  await grantGeneratorCatalog(auth, selection);
  await runDemoApp(auth.appName, selection, STAGE_DIR);
  logger.info("demo app deployed");
}

if (import.meta.main) {
  const controller = new AbortController();
  const unsubscribe = onParentTerminationSignal((signal) => {
    controller.abort(new Error(`demo deployment interrupted by ${signal}`));
  });
  try {
    await main(controller.signal);
  } catch (error) {
    logger.error(toError(error).message);
    process.exitCode = 1;
  } finally {
    unsubscribe();
  }
}
