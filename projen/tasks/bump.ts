#!/usr/bin/env -S bun
/**
 * Compute the next workspace version, write VERSION, and synthesize every
 * generated version surface. This task has no git, registry, or publication
 * side effects; release preparation owns those operations.
 */
import * as projectUtils from "@dbx-tools/core/project-utils";
import { log } from "@dbx-tools/shared-core";
import { Command, Option } from "commander";
import { runTaskCommand } from "../src/_task-command.ts";
import {
  resolveNextVersion,
  type VersionLevel,
  writeWorkspaceVersion,
} from "../src/workspace-version.ts";

const logger = log.logger("projen:bump");

export async function main(): Promise<void> {
  const program = new Command();
  program
    .description("Increment VERSION and synchronize generated workspace versions")
    .addOption(
      new Option("-l, --level <level>", "semver increment")
        .choices(["patch", "minor", "major"])
        .default("patch"),
    )
    .option("--no-synth", "write VERSION without synchronizing generated files")
    .action((opts: { level: VersionLevel; synth: boolean }) => {
      const root = projectUtils.root() ?? process.cwd();
      const next = resolveNextVersion(root, opts.level);

      logger.info(`bump ${next.base} -> ${next.version} (${opts.level})`);
      writeWorkspaceVersion(root, next.version);

      if (opts.synth) {
        runTaskCommand(root, process.execPath, [".projenrc.ts"]);
        // Package manifests are generated during the first synthesis, while
        // cross-package derived artifacts can read those manifests earlier in
        // the same pass. A second pass makes the new version visible to every
        // generator and leaves release validation on a converged tree.
        runTaskCommand(root, process.execPath, [".projenrc.ts"]);
      }
      logger.success(`workspace version synchronized at ${next.version}`);
    });

  await program.parseAsync();
}

if (import.meta.main) await main();
