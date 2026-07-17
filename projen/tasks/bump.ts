#!/usr/bin/env -S npx tsx
/**
 * `projen bump` - compute the next release version, then (by default) commit,
 * tag, and push it. Pushing the tag is what triggers the release workflow.
 *
 * The next version is derived from the HIGHER of:
 *   - the latest published git tag matching `<prefix><semver>` (fetched from
 *     the remote so a release made elsewhere is respected), and
 *   - the local `package.json` version,
 * then incremented by `--level` (patch | minor | major; default patch).
 *
 * Flags (all default ON; negate with the `--no-` form, per commander):
 *   --version / --no-version   write the bumped version into package.json
 *   --commit  / --no-commit    commit the version change
 *   --tag     / --no-tag       create the `<prefix><version>` git tag
 *   --push    / --no-push      push the branch + tag to origin
 *
 * `--publish` / `--no-publish` is an alias for `--push` (pushing the tag is
 * what publishes). The tag prefix comes from `--prefix` (default `v`).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import { exec } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";

const logger = log.logger("projen:bump");
const LEVELS = ["patch", "minor", "major"] as const;
type Level = (typeof LEVELS)[number];

/** Parse `x.y.z` (ignoring any leading `v`/prefix), returning a `[maj,min,pat]` tuple. */
function parseSemver(raw: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function increment(v: [number, number, number], level: Level): [number, number, number] {
  if (level === "major") return [v[0] + 1, 0, 0];
  if (level === "minor") return [v[0], v[1] + 1, 0];
  return [v[0], v[1], v[2] + 1];
}

function git(args: string[], capture = false): string {
  const res = exec.spawnSync("git", args, {
    cwd: process.cwd(),
    stdout: capture ? "capture" : "inherit",
    stderr: capture ? "ignore" : "inherit",
    stdin: "ignore",
    check: !capture,
  });
  return res.stdout?.trim() ?? "";
}

/** Highest remote tag matching `<prefix><semver>`, or undefined. `git fetch` first. */
function latestRemoteVersion(prefix: string): [number, number, number] | undefined {
  git(["fetch", "--tags", "--quiet"], true);
  const out = git(
    ["-c", "versionsort.suffix=-", "tag", "--sort=-version:refname", "--list", `${prefix}*`],
    true,
  );
  for (const tag of out.split("\n")) {
    const v = parseSemver(tag.replace(prefix, ""));
    if (v) return v;
  }
  return undefined;
}

function readPackageVersion(pkgPath: string): [number, number, number] {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  return parseSemver(pkg.version ?? "") ?? [0, 0, 0];
}

const program = new Command();
program
  .description("Bump the release version, then commit, tag, and push it")
  .addOption(new Option("-l, --level <level>", "semver increment").choices([...LEVELS]).default("patch"))
  .option("--prefix <prefix>", "git tag prefix", "v")
  // Declared in the `--no-` form so commander creates a boolean that defaults to
  // `true` and is turned off by `--no-version` / `--no-commit` / ... (the
  // positive `--version` etc. also work and are no-ops on the default).
  .option("--no-version", "do not write the bumped version into package.json")
  .option("--no-commit", "do not commit the version change")
  .option("--no-tag", "do not create the git tag")
  .option("--no-push", "do not push the branch and tag to origin")
  // `--publish` is a friendlier alias for `--push` (pushing the tag publishes).
  .option("--no-publish", "alias for --no-push")
  .action(
    (opts: {
      level: Level;
      prefix: string;
      version: boolean;
      commit: boolean;
      tag: boolean;
      push: boolean;
      publish: boolean;
    }) => {
      const pkgPath = resolve(process.cwd(), "package.json");
      if (!existsSync(pkgPath)) throw new Error(`no package.json in ${process.cwd()}`);

      // Base = higher of the latest remote tag and the local package version.
      const local = readPackageVersion(pkgPath);
      const remote = latestRemoteVersion(opts.prefix);
      const base = remote && compareSemver(remote, local) > 0 ? remote : local;
      const next = increment(base, opts.level);
      const version = next.join(".");
      const tag = `${opts.prefix}${version}`;
      logger.info(
        `bump ${base.join(".")} -> ${version} (${opts.level}); tag ${tag}` +
          `${remote ? "" : " [no remote tag]"}`,
      );

      const push = opts.push && opts.publish;

      if (opts.version) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
        pkg.version = version;
        writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
        logger.info(`wrote version ${version} to package.json`);
      }

      if (opts.commit && opts.version) {
        git(["add", "package.json"]);
        git(["commit", "-m", `chore(release): ${version}`]);
      }

      if (opts.tag) {
        git(["tag", "-a", tag, "-m", tag]);
        logger.info(`tagged ${tag}`);
      }

      if (push) {
        git(["push", "origin", "HEAD"]);
        if (opts.tag) git(["push", "origin", tag]);
        logger.success(`pushed ${opts.tag ? tag : "HEAD"} to origin`);
      } else {
        logger.info("skipped push (--no-push / --no-publish)");
      }
    },
  );

await program.parseAsync();
