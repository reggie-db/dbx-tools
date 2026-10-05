/** Publish one verified release candidate to configured loopback registries. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { log, net } from "@dbx-tools/shared-core";
import { Command } from "commander";
import { activePythonIndexes, resolveLocalPypi } from "./python-registry.ts";
import { verifyReleaseManifest } from "./release-manifest.ts";
import { runTaskCommandAsync } from "../src/_task-command.ts";

const logger = log.logger("projen:local-publish");

/** Options for publishing an immutable release candidate to local registries. */
export interface LocalPublishOptions {
  readonly candidateDirectory: string;
  readonly gitSha: string;
  readonly localPypi: string;
  readonly localRegistry: string;
  readonly root: string;
  readonly tag: string;
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

/** Publish the exact candidate archives before they are attached to the draft release. */
export async function publishLocalRelease(options: LocalPublishOptions): Promise<void> {
  const root = resolve(options.root);
  const candidateDirectory = resolve(options.candidateDirectory);
  verifyReleaseManifest({
    directory: candidateDirectory,
    gitSha: options.gitSha,
    tag: options.tag,
    version: options.version,
  });

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
    const publishNpmScript = fileURLToPath(new URL("./publish-npm.ts", import.meta.url));
    logger.info(`publishing approved npm archives to ${localRegistry}`);
    publishes.push(
      runTaskCommandAsync(root, process.execPath, [
        publishNpmScript,
        "--directory",
        candidateDirectory,
        "--version",
        options.version,
        "--registry",
        localRegistry,
      ]),
    );
  }

  if (localPypi) {
    const pythonDirectory = mkdtempSync(join(tmpdir(), "dbx-tools-local-pypi-"));
    verifyReleaseManifest({
      directory: candidateDirectory,
      gitSha: options.gitSha,
      kind: "pypi",
      output: pythonDirectory,
      tag: options.tag,
      version: options.version,
    });
    logger.info(`publishing approved Python distributions to ${localPypi.publishUrl}`);
    publishes.push(
      runTaskCommandAsync(
        root,
        "uvx",
        [
          "--from",
          "devpi-client",
          "devpi",
          "upload",
          "--index",
          localPypi.publishUrl,
          "--from-dir",
          pythonDirectory,
        ],
        { env: { ...process.env, UV_DEFAULT_INDEX: localPypi.indexUrl } },
      ).finally(() => rmSync(pythonDirectory, { recursive: true, force: true })),
    );
  }

  await Promise.all(publishes);

  logger.success(`published approved local candidate ${options.tag}`);
}

if (import.meta.main) {
  await new Command()
    .requiredOption("--candidate-directory <path>", "verified release candidate directory")
    .requiredOption("--sha <sha>", "exact release commit")
    .requiredOption("--tag <tag>", "annotated release tag")
    .requiredOption("--version <version>", "release version")
    .option("--root <path>", "repository root")
    .option("--local-registry <url>", "local npm registry", "auto")
    .option("--local-pypi <url>", "local devpi index", "auto")
    .action(
      (options: {
        candidateDirectory: string;
        sha: string;
        tag: string;
        version: string;
        root?: string;
        localRegistry: string;
        localPypi: string;
      }) =>
        publishLocalRelease({
          candidateDirectory: options.candidateDirectory,
          gitSha: options.sha,
          localPypi: options.localPypi,
          localRegistry: options.localRegistry,
          root: options.root ?? projectUtils.root() ?? process.cwd(),
          tag: options.tag,
          version: options.version,
        }),
    )
    .parseAsync();
}
