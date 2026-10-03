#!/usr/bin/env -S bun
/**
 * Compute the next workspace version, write VERSION, and synthesize every
 * generated version surface. This task has no git, registry, or publication
 * side effects; release preparation owns those operations.
 */
import * as projectUtils from "@dbx-tools/core/project-utils";
import { log } from "@dbx-tools/shared-core";
import { Command } from "commander";
import {
  releaseArchitectureOption,
  releaseLevelOption,
  releaseOperatingSystemOption,
  releasePlatformFilter,
  type ReleaseArch,
  type ReleaseOs,
  type VersionLevel,
} from "../src/_release-platform.ts";
import { runTaskCommand } from "../src/_task-command.ts";
import { resolveNextVersion, writeWorkspaceVersion } from "../src/workspace-version.ts";

const logger = log.logger("projen:bump");

const program = new Command();
program
  .description("Increment VERSION and synchronize generated workspace versions")
  .addOption(releaseLevelOption())
  .addOption(releaseOperatingSystemOption())
  .addOption(releaseArchitectureOption())
  .option("--no-synth", "write VERSION without synchronizing generated files")
  .action((opts: { level: VersionLevel; os: ReleaseOs[]; arch: ReleaseArch[]; synth: boolean }) => {
    const root = projectUtils.root() ?? process.cwd();
    const next = resolveNextVersion(root, opts.level);
    const releasePlatforms = releasePlatformFilter(opts.os, opts.arch);

    logger.info(`bump ${next.base} -> ${next.version} (${opts.level})`);
    writeWorkspaceVersion(root, next.version);

    if (opts.synth) {
      runTaskCommand(root, process.execPath, [".projenrc.ts"], {
        env: {
          ...process.env,
          ...(releasePlatforms ? { DBX_TOOLS_RELEASE_PLATFORMS: releasePlatforms } : {}),
        },
      });
    }
    logger.success(`workspace version synchronized at ${next.version}`);
  });

await program.parseAsync();
