#!/usr/bin/env -S bun
/**
 * Keep `bun.lock` free of private npm registry URLs.
 *
 * Detects the active npm registry and, when it is not public npm, rewrites
 * every tarball URL under it. Options also read `PROJEN_BUN_LOCKFILE_*`
 * environment variables and `.env`.
 */
import { relative } from "node:path";
import { log } from "@dbx-tools/shared-core";
import { runTaskMain, taskCommand, taskOptions, taskRoot } from "./cli.ts";
import { TaskRootOptionSchema } from "./options.ts";
import { BunLockfileOptionsSchema, normalizeBunLockfileAt } from "../src/bun-lockfile.ts";

const logger = log.logger("projen:bun-lockfile");

const TaskSchema = BunLockfileOptionsSchema.extend({ root: TaskRootOptionSchema });

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const { root, ...options } = await taskOptions(
    taskCommand(import.meta.url, "Keep bun.lock free of private npm registry URLs", TaskSchema),
    TaskSchema,
    args,
  );
  const result = normalizeBunLockfileAt(taskRoot(root), options);
  if (!result.exists || !result.changed) return;
  const file = relative(process.cwd(), result.path) || result.path;
  if (options.check) {
    throw new Error(
      `${file} contains ${result.rewritten} private registry tarball URLs; run \`bun run bun-lockfile\``,
    );
  }
  logger.info(`rewrote ${result.rewritten} private registry tarball URLs`, { file });
}

await runTaskMain(import.meta, main);
