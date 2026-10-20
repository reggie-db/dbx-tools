/**
 * Internal readiness gate and interactive Genie Code child process.
 *
 * @module
 */

import { configUtils, spawn } from "@dbx-tools/core";
import { log, poll } from "@dbx-tools/shared-core";
import { GenieCodeRunnerOptionsSchema } from "@dbx-tools/shared-genie-code";

/** Logical configuration key carrying serialized runner options. */
export const RUNNER_OPTIONS_KEY = "GENIE_RUNNER_OPTIONS";
const logger = log.logger("genie-code:runner");

/** Parse the serialized runner boundary from its private environment field. */
export function genieCodeRunnerOptions(environment: NodeJS.ProcessEnv = process.env) {
  const serialized = configUtils.resolveValue(RUNNER_OPTIONS_KEY, {
    data: environment,
    sources: "config",
  });
  if (!serialized) throw new Error(`${configUtils.name(RUNNER_OPTIONS_KEY)} is required`);
  return GenieCodeRunnerOptionsSchema.parse(JSON.parse(serialized));
}

/** Wait until the guarded model-gateway health route accepts the runner token. */
export async function waitForGenieCodeGateway(
  healthUrl: string,
  bearerToken: string,
  timeoutMs: number,
): Promise<void> {
  for await (const ready of poll(
    async ({ signal }) => {
      try {
        const response = await fetch(healthUrl, {
          headers: { authorization: `Bearer ${bearerToken}` },
          signal,
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    {
      intervalMs: 200,
      timeoutMs,
      predicate: (ready) => !ready,
    },
  )) {
    if (ready) return;
  }
}

/** Run Genie Code with inherited terminal streams after its gateway is ready. */
export async function runGenieCodeChild(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const options = genieCodeRunnerOptions(environment);
  logger.info("waiting for model gateway", {
    gateway: options.gatewayHealthUrl,
    timeoutMs: options.startupTimeoutMs,
  });
  await waitForGenieCodeGateway(
    options.gatewayHealthUrl,
    options.bearerToken,
    options.startupTimeoutMs,
  );
  logger.info("model gateway ready; starting Genie Code", {
    executable: options.executable,
    home: options.home,
  });
  const child = spawn(options.executable, [...options.arguments], {
    cwd: process.cwd(),
    env: {
      ...environment,
      GENIE_HOME: options.home,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    terminateTimeout: 5_000,
    killTimeout: 1_000,
  });
  const result = await child;
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}
