#!/usr/bin/env -S bun
/**
 * Compute the next workspace version, write VERSION, and synthesize every
 * generated version surface. This task has no git, registry, or publication
 * side effects; release preparation owns those operations.
 */
import { exec, project } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";
import { Command, Option } from "commander";
import { releasePlatformFilter } from "../src/_release-platform.ts";
import {
  type VersionLevel,
  resolveNextVersion,
  writeWorkspaceVersion,
} from "../src/workspace-version.ts";

const logger = log.logger("projen:bump");
const LEVELS = ["patch", "minor", "major"] as const;
const RELEASE_OSES = ["darwin", "linux", "win32"] as const;
const RELEASE_ARCHES = ["arm64", "x64"] as const;
type ReleaseOs = (typeof RELEASE_OSES)[number];
type ReleaseArch = (typeof RELEASE_ARCHES)[number];

function collectValue<T extends string>(value: T, previous: T[]): T[] {
  return [...previous, value];
}

const program = new Command();
program
  .description("Increment VERSION and synchronize generated workspace versions")
  .addOption(
    new Option("-l, --level <level>", "semver increment").choices([...LEVELS]).default("patch"),
  )
  .option("--prefix <prefix>", "git tag prefix used to resolve the published base", "v")
  .addOption(
    new Option("--os <os>", "release operating system, repeatable; crossed with every --arch")
      .choices([...RELEASE_OSES])
      .argParser((value, previous: ReleaseOs[]) => collectValue(value as ReleaseOs, previous))
      .default([] as ReleaseOs[]),
  )
  .addOption(
    new Option("--arch <arch>", "release CPU architecture, repeatable; crossed with every --os")
      .choices([...RELEASE_ARCHES])
      .argParser((value, previous: ReleaseArch[]) => collectValue(value as ReleaseArch, previous))
      .default([] as ReleaseArch[]),
  )
  .option("--no-synth", "write VERSION without synchronizing generated files")
  .action(
    (opts: {
      level: VersionLevel;
      prefix: string;
      os: ReleaseOs[];
      arch: ReleaseArch[];
      synth: boolean;
    }) => {
      const root = project.root() ?? process.cwd();
      const next = resolveNextVersion(root, [opts.prefix], opts.level);
      const releasePlatforms = releasePlatformFilter(opts.os, opts.arch);

      logger.info(
        `bump ${next.base} -> ${next.version} (${opts.level})` +
          `${next.source === "remote" ? "" : " [no remote tag; used local VERSION]"}`,
      );
      writeWorkspaceVersion(root, next.version);

      if (opts.synth) {
        exec.spawnSync(process.execPath, [".projenrc.ts"], {
          cwd: root,
          stdout: "inherit",
          stderr: "inherit",
          stdin: "ignore",
          check: true,
          env: {
            ...process.env,
            ...(releasePlatforms ? { DBX_TOOLS_RELEASE_PLATFORMS: releasePlatforms } : {}),
          },
        });
      }
      logger.success(`workspace version synchronized at ${next.version}`);
    },
  );

await program.parseAsync();
