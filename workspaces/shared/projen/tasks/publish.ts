#!/usr/bin/env -S npx tsx
/**
 * Projen task entry for release (`publish`, `package`, `release:tag`).
 */
import { Command, Option } from "commander";
import {
  buildFromTag,
  packForRelease,
  publish,
  type BumpLevel,
} from "../src/publish";

const INCREMENT_LEVELS = ["patch", "minor", "major"] as const;

function parseIncrement(value: string): BumpLevel {
  if ((INCREMENT_LEVELS as readonly string[]).includes(value)) return value as BumpLevel;
  throw new Error(`invalid --increment: ${value} (expected patch, minor, or major)`);
}

const program = new Command();
program
  .option("--pack", "sync version and pnpm pack into dist/js (projen package task)")
  .option("--ci", "CI: build and pack from the git tag (projen release:tag task)")
  .addOption(
    new Option("--increment [level]", "semver bump level")
      .choices([...INCREMENT_LEVELS])
      .default("patch"),
  )
  .action((opts: { pack?: boolean; ci?: boolean; increment: string }) => {
    if (opts.ci) buildFromTag();
    else if (opts.pack) packForRelease();
    else publish(undefined, parseIncrement(opts.increment));
  });

program.parseAsync();
