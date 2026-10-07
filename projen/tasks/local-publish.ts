/** Build and publish the current workspace to configured loopback registries. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { log, net } from "@dbx-tools/shared-core";
import { activePythonIndexes, resolveLocalPypi } from "./python-registry.ts";
import { runTaskCommandAsync } from "../src/_task-command.ts";

const logger = log.logger("projen:local-publish");

/** Options for publishing the current workspace to local registries. */
export interface LocalPublishOptions {
  readonly localPypi: string;
  readonly localRegistry: string;
  readonly pythonRoot: string;
  readonly root: string;
  readonly version: string;
}

export function resolveLocalRegistry(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "false") return undefined;
  if (trimmed.toLowerCase() === "auto") {
    const registry = projectUtils.npmRegistry();
    return registry && net.isLoopbackHost(registry) ? registry.href : undefined;
  }
  return trimmed;
}

/** Outcome of a local publish: which ecosystems were deployed to a local registry. */
export interface LocalPublishResult {
  readonly npm: boolean;
  readonly python: boolean;
}

/** Resolve a sibling release task after task implementations are flattened. */
export function localPublishTaskPath(task: "publish.ts" | "publish-python.ts"): string {
  return fileURLToPath(new URL(task, import.meta.url));
}

/** Build and publish the current workspace directly to local registries. */
export async function publishLocalRelease(
  options: LocalPublishOptions,
): Promise<LocalPublishResult> {
  const root = resolve(options.root);
  const localRegistry = resolveLocalRegistry(options.localRegistry);
  const activeIndexes = activePythonIndexes();
  const localPypi = resolveLocalPypi(options.localPypi, activeIndexes);
  const publishes: Promise<unknown>[] = [];

  if (
    options.localPypi.toLowerCase() === "auto" &&
    activeIndexes.some((index) => net.isLoopbackHost(index)) &&
    !localPypi
  ) {
    logger.info(
      `skipped local Python publish: no active index (${activeIndexes.join(", ")}) is a devpi +simple index`,
    );
  }

  if (localRegistry) {
    const publishNpmScript = localPublishTaskPath("publish.ts");
    logger.info(`building and publishing npm workspace to ${localRegistry}`);
    publishes.push(
      runTaskCommandAsync(root, process.execPath, [
        publishNpmScript,
        options.version,
        "--registry",
        localRegistry,
      ]),
    );
  }

  if (localPypi) {
    const publishPythonScript = localPublishTaskPath("publish-python.ts");
    logger.info(`building and publishing Python workspace to ${localPypi.publishUrl}`);
    publishes.push(
      runTaskCommandAsync(root, process.execPath, [
        publishPythonScript,
        options.version,
        "--root",
        options.pythonRoot,
        "--index-url",
        localPypi.indexUrl,
        "--publish-url",
        localPypi.publishUrl,
      ]),
    );
  }

  if (publishes.length === 0) {
    logger.info("no local registries configured; skipping local publish");
    return { npm: false, python: false };
  }

  await Promise.all(publishes);
  logger.success(`published local workspace ${options.version}`);
  return { npm: Boolean(localRegistry), python: Boolean(localPypi) };
}
