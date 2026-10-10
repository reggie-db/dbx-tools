#!/usr/bin/env -S bun
/**
 * Compute the next workspace version, write VERSION, and synthesize every
 * generated version surface. This task has no git, registry, or publication
 * side effects; release preparation owns those operations.
 */
import * as projectUtils from "@dbx-tools/core/project-utils";
import { log } from "@dbx-tools/shared-core";
import { z } from "zod";
import { runTaskMain, taskCommand, taskOptions, taskRoot } from "./cli.ts";
import { TaskRootOptionSchema } from "./options.ts";
import { runTaskCommand } from "../src/_task-command.ts";
import {
  resolveNextVersion,
  type VersionLevel,
  writeWorkspaceVersion,
} from "../src/workspace-version.ts";

const logger = log.logger("projen:bump");

export const BumpOptionsSchema = z.object({
  root: TaskRootOptionSchema,
  level: z
    .enum(["patch", "minor", "major"])
    .default("patch")
    .describe("Semantic version increment")
    .meta({ short: "l" }),
  synth: z.boolean().default(true).describe("Synchronize generated workspace versions"),
});

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const options = await taskOptions(
    taskCommand(
      import.meta.url,
      "Increment VERSION and synchronize generated workspace versions",
      BumpOptionsSchema,
    ),
    BumpOptionsSchema,
    args,
  );
  const root = taskRoot(options.root ?? projectUtils.root());
  const level: VersionLevel = options.level;
  const next = resolveNextVersion(root, level);

  logger.info(`bump ${next.base} -> ${next.version} (${level})`);
  writeWorkspaceVersion(root, next.version);

  if (options.synth) {
    runTaskCommand(root, process.execPath, [".projenrc.ts"]);
    runTaskCommand(root, process.execPath, [".projenrc.ts"]);
  }
  logger.success(`workspace version synchronized at ${next.version}`);
}

await runTaskMain(import.meta, main);
