#!/usr/bin/env -S bun
/**
 * `projen bump` - compute the next release version, write it to the workspace
 * `VERSION` file, synth so every manifest copies it, then (by default) commit,
 * tag, and push. Pushing the tag is what triggers the release workflow.
 *
 * The base version is the HIGHEST published git tag across `<prefix>` and every
 * `--sibling` prefix (fetched from the remote so a release cut elsewhere wins),
 * falling back to the local `VERSION` file when the remote is unreachable or has
 * no matching tag. A local file that is ahead does NOT override an existing
 * remote tag. The base is then incremented by `--level` (patch | minor | major;
 * default patch). The remote is consulted only here and on VERSION bootstrap,
 * never on an ordinary synth.
 *
 * `--sibling <dir>:<tagPrefix>` (repeatable) releases an in-repo project that
 * publishes on its OWN tag namespace (e.g. `projen/`, tagged `projen-v*`) at the
 * SAME version as the root, in the same run: its `<tagPrefix><version>` tag is
 * cut and pushed (triggering its own workflow), and it is included in the
 * local-registry publish. Taking the base version from every prefix at once is
 * what keeps the two in lockstep: the engine sat at 0.1.24 while the packages
 * reached 0.3.41 precisely because each namespace only ever looked at its own
 * tags. Both draw the fallback from the one root `VERSION` file, so the engine
 * and the packages share a single source of truth.
 *
 * Flags (all default ON; negate with the `--no-` form, per commander):
 *   --synth   / --no-synth     synth after writing VERSION so manifests copy it
 *   --version / --no-version   write the bumped version into `VERSION`
 *   --commit  / --no-commit    commit the release (staged with `git add -A`)
 *   --tag     / --no-tag       create the `<prefix><version>` git tag
 *   --push    / --no-push      push the CURRENT branch + tag to origin
 *
 * `--publish` / `--no-publish` is an alias for `--push` (pushing the tag is
 * what publishes). The tag prefix comes from `--prefix` (default `v`).
 *
 * `--local-registry <value>` publishes npm packages to a LOCAL registry (e.g.
 * verdaccio) right after the tag push. `--local-pypi <value>` does the same for
 * Python packages through a writable devpi index. Values for both:
 *   - `auto` (default): publish only when `npm config get registry` is a
 *     loopback host, or when ANY active Python index — the primary
 *     `index-url` OR any `extra-index-url`, across uv and pip — is a loopback
 *     devpi URL. Scanning the extras is what lets the corp proxy stay the
 *     primary index while a local devpi added as an extra is the detected
 *     publish target. The deploy endpoint for that index is taken from the
 *     GLOBAL uv config — an explicit `publish-url` on the matching `[[index]]`
 *     (or `UV_PUBLISH_URL`) — falling back to deriving it from the `+simple`
 *     URL shape when no such setting exists.
 *   - `false`: never publish locally.
 *   - a URL: always publish to that registry.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, project } from "@dbx-tools/core";
import { log, net } from "@dbx-tools/shared-core";
import { Command, Option } from "commander";
import { activePythonIndexes, resolveLocalPypi } from "./python-registry.ts";
import {
  type Semver,
  compareSemver,
  latestTagVersion,
  parseSemver,
  resolveBaseVersion,
  writeWorkspaceVersion,
} from "../src/workspace-version.ts";

const logger = log.logger("projen:bump");
const LEVELS = ["patch", "minor", "major"] as const;
type Level = (typeof LEVELS)[number];

/** A standalone in-repo project released alongside the root, on its own tag prefix. */
interface Sibling {
  /** Repo-relative directory, e.g. `projen`. */
  readonly dir: string;
  /** Git tag prefix, disjoint from the root's, e.g. `projen-v`. */
  readonly prefix: string;
}

/**
 * Commander collector for the repeatable `--sibling <dir>:<tagPrefix>`. Split on
 * the LAST colon so a directory containing one still parses.
 */
function parseSibling(value: string, previous: Sibling[]): Sibling[] {
  const at = value.lastIndexOf(":");
  if (at <= 0 || at === value.length - 1) {
    throw new Error(`--sibling expects <dir>:<tagPrefix>, got "${value}"`);
  }
  return [...previous, { dir: value.slice(0, at), prefix: value.slice(at + 1) }];
}

function increment(v: Semver, level: Level): Semver {
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

/**
 * Write ONLY the `version` field into a manifest projen owns (read-only, so
 * bracketed by a chmod that restores the mode). Used for the ROOT and the
 * standalone `projen/` sibling so the committed release marks the version.
 *
 * It deliberately does NOT rewrite `@scope/*` dep ranges. `projen/` is a workspace
 * member with `workspace:*` sibling deps; baking a `^version` for the just-bumped
 * (not-yet-published) version into the COMMITTED manifest breaks the release
 * workflow's initial `bun install`, which checks out that commit before anything
 * is published. Sibling versions are resolved transiently at publish time instead:
 * `projen-release` runs `tasks/publish.ts --stamp-only` (set versions + refresh
 * lockfile), then `bun publish` in `projen/` strips `workspace:*` to those versions.
 */
function writeManifestVersion(pkgPath: string, version: string): void {
  const { mode } = statSync(pkgPath);
  chmodSync(pkgPath, mode | 0o200);
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    pkg.version = version;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  } finally {
    chmodSync(pkgPath, mode);
  }
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
  .addOption(
    new Option("-l, --level <level>", "semver increment").choices([...LEVELS]).default("patch"),
  )
  .option("--prefix <prefix>", "git tag prefix", "v")
  .option(
    "--sibling <dir:prefix>",
    "standalone in-repo project (not a workspace member) to release at the same version, repeatable",
    parseSibling,
    [] as Sibling[],
  )
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
  .option(
    "--local-pypi <value>",
    "publish Python packages locally: 'auto' (any active index-url or extra-index-url that is a loopback devpi +simple), 'false', or a devpi URL",
    "auto",
  )
  .option("--python-root <path>", "Python workspace package root", "packages/py")
  .action(
    async (opts: {
      level: Level;
      prefix: string;
      sibling: Sibling[];
      synth: boolean;
      version: boolean;
      commit: boolean;
      tag: boolean;
      push: boolean;
      publish: boolean;
      localPypi: string;
      localRegistry: string;
      pythonRoot: string;
    }) => {
      const pkgPath = resolve(process.cwd(), "package.json");
      if (!existsSync(pkgPath)) throw new Error(`no package.json in ${process.cwd()}`);

      const siblings = opts.sibling.map((s) => ({ ...s, pkgPath: resolve(s.dir, "package.json") }));
      for (const s of siblings) {
        if (!existsSync(s.pkgPath)) throw new Error(`--sibling ${s.dir}: no package.json there`);
      }

      // The `VERSION` file is the workspace source of truth and lives at the repo
      // root, even when this task runs from a subdirectory (`cd projen && bun run
      // bump`), so the engine and packages always share one number.
      const root = project.root() ?? process.cwd();

      // Base = the highest published tag across EVERY namespace being released
      // (fetched from the remote so a release cut elsewhere wins), falling back to
      // the local `VERSION` file when the remote is unreachable or has no tag. A
      // local file that happens to be ahead does NOT override an existing remote.
      const prefixes = [opts.prefix, ...siblings.map((s) => s.prefix)];
      const baseInfo = resolveBaseVersion(root, prefixes);
      const base = parseSemver(baseInfo.version) ?? [0, 0, 1];
      const next = increment(base, opts.level);
      const version = next.join(".");
      const tags = prefixes.map((prefix) => `${prefix}${version}`);
      logger.info(
        `bump ${base.join(".")} -> ${version} (${opts.level}); tags ${tags.join(", ")}` +
          `${baseInfo.source === "remote" ? "" : " [no remote tag; used local VERSION]"}`,
      );
      // Note any tag namespace that trailed the base so a lockstep catch-up is visible.
      for (const prefix of prefixes) {
        const tagged = latestTagVersion(root, prefix);
        if (tagged && compareSemver(tagged, base) < 0) {
          logger.info(`${prefix}* was behind at ${tagged.join(".")}, catching it up`);
        }
      }

      const push = opts.push && opts.publish;

      // Write the source of truth first, then synth so every generated manifest
      // COPIES it - synth never invents, resets, or drifts a version on its own.
      if (opts.version) {
        writeWorkspaceVersion(root, version);
        // Keep the writable root/sibling manifests coherent even when synth is
        // skipped (`--no-synth`); synth would otherwise set the same value.
        writeManifestVersion(pkgPath, version);
        for (const s of siblings) writeManifestVersion(s.pkgPath, version);
        logger.info(`wrote version ${version} to ${root}/VERSION`);
      }

      if (opts.synth) {
        logger.info("synthesizing (projen)");
        exec.spawnSync("bun", [".projenrc.ts"], {
          cwd: process.cwd(),
          stdout: "inherit",
          stderr: "inherit",
          stdin: "ignore",
          check: true,
        });
      }

      if (opts.commit) {
        // Stage the whole tree so the release commit captures the version bump
        // plus anything synth regenerated. Skip the commit when nothing changed.
        git(["add", "-A"]);
        const staged = git(["diff", "--cached", "--name-only"], true);
        if (staged) {
          git([
            "commit",
            "-m",
            `chore(release): ${version}`,
            "-m",
            "🌸 Shipped with Kanna — https://kanna.sh",
            "-m",
            "Co-Authored-By: Kanna <noreply@kanna.sh>\nKanna-Agent: codex/databricks-gpt-5-6-sol",
          ]);
        } else logger.info("nothing to commit");
      }

      if (opts.tag) {
        for (const t of tags) git(["tag", "-a", t, "-m", t]);
        logger.info(`tagged ${tags.join(", ")}`);
      }

      if (push) {
        git(["push", "origin", "HEAD"]);
        // Push every tag in ONE invocation: each push triggers a workflow, and a
        // partial push would release half the set at this version.
        if (opts.tag) git(["push", "origin", ...tags]);
        logger.success(`pushed ${opts.tag ? tags.join(", ") : "HEAD"} to origin`);
      } else {
        logger.info("skipped push (--no-push / --no-publish)");
      }

      // Local registry (e.g. verdaccio): publish AFTER the tag push so the
      // GitHub release still owns the public registry. Skipped under
      // `--no-version` (nothing bumped to publish).
      const localRegistry = resolveLocalRegistry(opts.localRegistry);
      const publishToLocalRegistry = opts.version && localRegistry;
      if (opts.version === false && localRegistry) {
        logger.info("skipped local publish (--no-version left package.json unbumped)");
      }
      // Scan EVERY active index (primary index-url + every extra-index-url,
      // across uv and pip): auto-mode publishes to the first that is a loopback
      // devpi +simple, so the corp proxy stays primary and a local devpi added
      // as an extra index is the detected publish target.
      const activeIndexes = activePythonIndexes();
      const localPypi = resolveLocalPypi(opts.localPypi, activeIndexes);
      const pythonRoot = resolve(opts.pythonRoot);
      if (
        opts.localPypi.toLowerCase() === "auto" &&
        activeIndexes.some((index) => net.isLoopbackHost(index)) &&
        !localPypi
      ) {
        logger.info(
          `skipped local Python publish: no active index (${activeIndexes.join(", ")}) is a devpi +simple index`,
        );
      }
      if (opts.version === false && localPypi) {
        logger.info("skipped local Python publish (--no-version left packages unstamped)");
      }

      // npm and Python touch disjoint package trees and registries. Start both
      // mirrors together so local publishing takes the slower duration rather
      // than the sum of both. Each child still owns its internal build/upload
      // ordering and restores its temporary manifest edits on exit.
      const localPublishes: Promise<unknown>[] = [];
      if (publishToLocalRegistry) {
        logger.info(`publishing ${version} to local registry ${localRegistry}`);
        // The shared driver skips stamping/install when synth already made the
        // workspace release-current, compiles publishable members once from the
        // root, then publishes through a bounded pool. Temporary publishConfig
        // edits are restored before this child exits.
        const publishScript = fileURLToPath(new URL("./publish.ts", import.meta.url));
        localPublishes.push(
          exec
            .spawn("bun", [publishScript, version, "--registry", localRegistry], {
              cwd: process.cwd(),
              stdout: "inherit",
              stderr: "inherit",
              stdin: "ignore",
              check: true,
            })
            .then(() => logger.success(`published ${version} to ${localRegistry}`)),
        );
      }
      if (opts.version && localPypi && existsSync(pythonRoot)) {
        logger.info(`publishing Python ${version} to local devpi ${localPypi.publishUrl}`);
        const publishPythonScript = fileURLToPath(new URL("./publish-python.ts", import.meta.url));
        localPublishes.push(
          exec
            .spawn(
              "bun",
              [
                publishPythonScript,
                version,
                "--root",
                pythonRoot,
                "--index-url",
                localPypi.indexUrl,
                "--publish-url",
                localPypi.publishUrl,
              ],
              {
                cwd: process.cwd(),
                stdout: "inherit",
                stderr: "inherit",
                stdin: "ignore",
                check: true,
              },
            )
            .then(() => logger.success(`published Python ${version} to ${localPypi.publishUrl}`)),
        );
      }
      await Promise.all(localPublishes);
    },
  );

await program.parseAsync();
