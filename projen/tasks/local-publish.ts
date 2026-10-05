/** Build and publish the current workspace to configured loopback registries. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { log, net } from "@dbx-tools/shared-core";
import { Command } from "commander";
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

/** Build and publish the current workspace directly to local registries. */
export async function publishLocalRelease(options: LocalPublishOptions): Promise<void> {
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
    const publishNpmScript = fileURLToPath(new URL("./publish.ts", import.meta.url));
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
    const publishPythonScript = fileURLToPath(new URL("./publish-python.ts", import.meta.url));
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

  await Promise.all(publishes);
  logger.success(`published local workspace ${options.version}`);
}

if (import.meta.main) {
  await new Command()
    .requiredOption("--version <version>", "release version")
    .option("--root <path>", "repository root")
    .option("--python-root <path>", "Python package root", "packages/py")
    .option("--local-registry <url>", "local npm registry", "auto")
    .option("--local-pypi <url>", "local devpi index", "auto")
    .action(
      (options: {
        version: string;
        root?: string;
        pythonRoot: string;
        localRegistry: string;
        localPypi: string;
      }) =>
        publishLocalRelease({
          localPypi: options.localPypi,
          localRegistry: options.localRegistry,
          pythonRoot: options.pythonRoot,
          root: options.root ?? projectUtils.root() ?? process.cwd(),
          version: options.version,
        }),
    )
    .parseAsync();
}
