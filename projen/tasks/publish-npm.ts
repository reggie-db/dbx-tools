#!/usr/bin/env -S bun
/** Idempotent npm archive publication for release recovery. */
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { log, mapConcurrent } from "@dbx-tools/shared-core";
import { z } from "zod";
import { runTaskMain, taskCommand, taskOptions } from "./cli.ts";
import { TaskConcurrencyOptionSchema, TaskDryRunOptionSchema } from "./options.ts";
import {
  publishNpmArchive,
  readNpmArchiveIdentity,
  readNpmArchiveManifest,
} from "../src/npm-release.ts";

const DEFAULT_PUBLISH_CONCURRENCY = 4;
const logger = log.logger("projen:publish-npm");

function npmArchiveLayers(archives: readonly string[]): string[][] {
  const byName = new Map(
    archives.map((archive) => {
      const manifest = readNpmArchiveManifest(archive);
      if (!manifest.name) throw new Error(`npm archive has no package name: ${archive}`);
      return [manifest.name, { archive, manifest }] as const;
    }),
  );
  if (byName.size !== archives.length) throw new Error("Release contains duplicate npm packages");
  const remaining = new Map(
    [...byName].map(([name, value]) => [
      name,
      new Set(
        [
          ...Object.keys(value.manifest.dependencies ?? {}),
          ...Object.keys(value.manifest.optionalDependencies ?? {}),
        ].filter((dependency) => byName.has(dependency)),
      ),
    ]),
  );
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      throw new Error(
        `Cyclic npm release dependencies: ${[...remaining.keys()].sort().join(", ")}`,
      );
    }
    layers.push(ready.map((name) => byName.get(name)!.archive));
    for (const name of ready) remaining.delete(name);
    for (const dependencies of remaining.values()) {
      for (const name of ready) dependencies.delete(name);
    }
  }
  return layers;
}

/** Publish dependency-ordered npm archives, skipping only exact registry matches. */
export async function publishNpmArchives(options: {
  readonly concurrency?: number;
  readonly directory: string;
  readonly dryRun?: boolean;
  readonly registry?: string;
  readonly version?: string;
}): Promise<void> {
  const directory = resolve(options.directory);
  const layers = npmArchiveLayers(
    readdirSync(directory)
      .filter((file) => file.endsWith(".tgz"))
      .sort()
      .map((file) => join(directory, file)),
  );
  if (layers.length === 0) throw new Error(`No npm archives found in ${directory}`);

  for (const archives of layers) {
    await mapConcurrent(
      archives,
      async (archive) => {
        const local = readNpmArchiveIdentity(archive);
        if (options.version && local.version !== options.version) {
          throw new Error(
            `npm archive ${archive} carries ${local.version}, expected ${options.version}`,
          );
        }
        const outcome = await publishNpmArchive({
          archive,
          identity: local,
          dryRun: options.dryRun,
          registry: options.registry,
        });
        if (outcome === "skipped") {
          logger.info(`skip published ${local.name}@${local.version}`);
        }
      },
      {
        concurrency: options.concurrency ?? DEFAULT_PUBLISH_CONCURRENCY,
        errorMode: "settle",
      },
    );
  }
}

/** Parse npm archive publication options and execute the publisher. */
export const PublishNpmOptionsSchema = z.object({
  directory: z.string().trim().min(1).describe("Directory containing npm archives"),
  version: z.string().trim().min(1).optional().describe("Expected npm release version"),
  registry: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("npm registry URL")
    .meta({ env: "NPM_CONFIG_REGISTRY" }),
  dryRun: TaskDryRunOptionSchema,
  concurrency: TaskConcurrencyOptionSchema.default(DEFAULT_PUBLISH_CONCURRENCY),
});

/** Parse task options and publish validated npm release archives. */
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const options = await taskOptions(
    taskCommand(import.meta.url, "Publish validated npm release archives", PublishNpmOptionsSchema),
    PublishNpmOptionsSchema,
    args,
  );
  await publishNpmArchives(options);
}

await runTaskMain(import.meta, main);
