#!/usr/bin/env -S bun
/**
 * Compute the next workspace version, write VERSION, and synthesize every
 * generated version surface. This task has no git, registry, or publication
 * side effects; release preparation owns those operations.
 */
import { join } from "node:path";
import { projectUtils } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";
import { z } from "zod";
import { runTaskMain, taskRoot } from "./cli.ts";
import { runTaskCommand } from "../src/_task-command.ts";
import {
  resolveNextVersion,
  type VersionLevel,
  writeWorkspaceVersion,
} from "../src/workspace-version.ts";

const logger = log.logger("projen:bump");

export const BumpOptionsSchema = z
  .object({
    root: z.string().trim().min(1).optional().describe("Repository or workspace root"),
    level: z
      .enum(["patch", "minor", "major"])
      .default("patch")
      .describe("Semantic version increment")
      .meta({ short: "l" }),
    synth: z.boolean().default(true).describe("Synchronize generated workspace versions"),
  })
  .describe("Increment VERSION and synchronize generated workspace versions");

export const main = await runTaskMain(import.meta, BumpOptionsSchema, (options) => {
  const root = taskRoot(options.root ?? projectUtils.root());
  const level: VersionLevel = options.level;
  const next = resolveNextVersion(root, level);

  logger.info(`bump ${next.base} -> ${next.version} (${level})`);
  writeWorkspaceVersion(root, next.version);

  if (options.synth) {
    const env = { ...process.env };
    delete env.PROJEN_DISABLE_POST;
    const synth = (): void =>
      runTaskCommand(root, process.execPath, [join(root, ".projenrc.ts")], { env });
    synth();
    synth();
  }
  logger.success(`workspace version synchronized at ${next.version}`);
});
