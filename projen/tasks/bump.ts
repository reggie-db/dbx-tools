#!/usr/bin/env -S npx tsx
/**
 * `projen bump` - synth, compute the next release version, then (by default)
 * commit, tag, and push it. Pushing the tag is what triggers the release
 * workflow.
 *
 * The next version is derived from the HIGHER of:
 *   - the latest published git tag matching `<prefix><semver>` (fetched from
 *     the remote so a release made elsewhere is respected), and
 *   - the local `package.json` version,
 * then incremented by `--level` (patch | minor | major; default patch).
 *
 * Flags (all default ON; negate with the `--no-` form, per commander):
 *   --synth   / --no-synth     run `projen` (synth) first so the tree is current
 *   --version / --no-version   write the bumped version into package.json
 *   --commit  / --no-commit    commit the release (staged with `git add -A`)
 *   --tag     / --no-tag       create the `<prefix><version>` git tag
 *   --push    / --no-push      push the CURRENT branch + tag to origin
 *
 * `--publish` / `--no-publish` is an alias for `--push` (pushing the tag is
 * what publishes). The tag prefix comes from `--prefix` (default `v`).
 *
 * `--local-registry <value>` publishes the just-tagged version to a LOCAL
 * registry (e.g. a verdaccio) right after the git tag is pushed - so a local
 * `pnpm run bump` both fires the GitHub release (public npm) and populates your
 * local registry. Values:
 *   - `auto` (default): publish only when `npm config get registry` is a
 *     loopback host (`localhost` / `127.0.0.0/8` / `::1`); otherwise skip.
 *   - `false`: never publish locally.
 *   - a URL: always publish to that registry.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import { exec, project } from "@dbx-tools/core";
import { log, net } from "@dbx-tools/shared-core";

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

/**
 * Resolve the `--local-registry` value to a registry URL to publish to, or
 * `undefined` to skip. `false` skips; a URL is used as-is; `auto` uses the
 * active npm registry only when it is a loopback host (a local verdaccio etc.).
 */
function resolveLocalRegistry(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "false") return undefined;
  if (trimmed.toLowerCase() === "auto") {
    const registry = project.npmRegistry();
    return registry && net.isLoopbackHost(registry) ? registry.href : undefined;
  }
  return trimmed;
}

const program = new Command();
program
  .description("Bump the release version, then commit, tag, and push it")
  .addOption(new Option("-l, --level <level>", "semver increment").choices([...LEVELS]).default("patch"))
  .option("--prefix <prefix>", "git tag prefix", "v")
  // Declared in the `--no-` form so commander creates a boolean that defaults to
  // `true` and is turned off by `--no-synth` / `--no-version` / ... (the
  // positive `--synth` etc. also work and are no-ops on the default).
  .option("--no-synth", "do not run `projen` (synth) before bumping")
  .option("--no-version", "do not write the bumped version into package.json")
  .option("--no-commit", "do not commit the version change")
  .option("--no-tag", "do not create the git tag")
  .option("--no-push", "do not push the branch and tag to origin")
  // `--publish` is a friendlier alias for `--push` (pushing the tag publishes).
  .option("--no-publish", "alias for --no-push")
  .option(
    "--local-registry <value>",
    "publish locally after the tag push: 'auto' (only a loopback npm registry), 'false', or a registry URL",
    "auto",
  )
  .action(
    (opts: {
      level: Level;
      prefix: string;
      synth: boolean;
      version: boolean;
      commit: boolean;
      tag: boolean;
      push: boolean;
      publish: boolean;
      localRegistry: string;
    }) => {
      const pkgPath = resolve(process.cwd(), "package.json");
      if (!existsSync(pkgPath)) throw new Error(`no package.json in ${process.cwd()}`);

      // Synth first so the release commit captures an up-to-date tree (generated
      // manifests, workspace file, tasks, ...) rather than a stale one.
      if (opts.synth) {
        logger.info("synthesizing (projen)");
        exec.spawnSync("pnpm", ["exec", "projen"], {
          cwd: process.cwd(),
          stdout: "inherit",
          stderr: "inherit",
          stdin: "ignore",
          check: true,
        });
      }

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

      if (opts.commit) {
        // Stage the whole tree so the release commit captures the version bump
        // plus anything synth regenerated. Skip the commit when nothing changed.
        git(["add", "-A"]);
        const staged = git(["diff", "--cached", "--name-only"], true);
        if (staged) git(["commit", "-m", `chore(release): ${version}`]);
        else logger.info("nothing to commit");
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

      // Local registry (e.g. verdaccio): publish AFTER the tag push so the
      // GitHub release still owns the public registry. `pnpm -r publish` reads
      // each package's version (bumped on disk above) and rewrites `workspace:*`
      // sibling pins to it; from a single-package project it just publishes that
      // one package. Needs the bumped version on disk, so skip under `--no-version`.
      const localRegistry = resolveLocalRegistry(opts.localRegistry)
      const publishToLocalRegistry = opts.version && localRegistry;
      if (opts.version === false && localRegistry) {
        logger.info("skipped local publish (--no-version left package.json unbumped)");
      }
      if (publishToLocalRegistry) {
        logger.info(`publishing ${version} to local registry ${localRegistry}`);
        // Provenance is opt-in (see `.projenrc.ts`): the generated
        // `publishConfig` omits it, so local (verdaccio) publishes never try to
        // attest. CI turns it on with `npm_config_provenance=true`.
        exec.spawnSync(
          "pnpm",
          ["-r", "publish", "--registry", localRegistry, "--no-git-checks", "--access", "public"],
          { cwd: process.cwd(), stdout: "inherit", stderr: "inherit", stdin: "ignore", check: true },
        );
        logger.success(`published ${version} to ${localRegistry}`);
      }
    },
  );

await program.parseAsync();
