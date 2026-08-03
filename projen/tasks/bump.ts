#!/usr/bin/env -S bun
/**
 * `projen bump` - synth, compute the next release version, then (by default)
 * commit, tag, and push it. Pushing the tag is what triggers the release
 * workflow.
 *
 * The next version is derived from the HIGHEST of:
 *   - the latest published git tag matching `<prefix><semver>` (fetched from
 *     the remote so a release made elsewhere is respected),
 *   - the same for every `--sibling` prefix, and
 *   - the local `package.json` version,
 * then incremented by `--level` (patch | minor | major; default patch).
 *
 * `--sibling <dir>:<tagPrefix>` (repeatable) releases an in-repo project that
 * publishes on its OWN tag namespace (e.g. `projen/`, tagged `projen-v*`) at the
 * SAME version as the root, in the same run: its manifest version is stamped, its
 * `<tagPrefix><version>` tag is cut and pushed (triggering its own workflow), and
 * it is included in the local-registry publish. Taking the base version from
 * every prefix at once is what keeps the two in lockstep: the engine sat at
 * 0.1.24 while the packages reached 0.3.41 precisely because each namespace only
 * ever looked at its own tags.
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
 * `bun run bump` both fires the GitHub release (public npm) and populates your
 * local registry. Values:
 *   - `auto` (default): publish only when `npm config get registry` is a
 *     loopback host (`localhost` / `127.0.0.0/8` / `::1`); otherwise skip.
 *   - `false`: never publish locally.
 *   - a URL: always publish to that registry.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, project } from "@dbx-tools/core";
import { log, net } from "@dbx-tools/shared-core";
import { Command, Option } from "commander";

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

/** Highest tag matching `<prefix><semver>`, or undefined. Call {@link fetchTags} first. */
function latestTagVersion(prefix: string): [number, number, number] | undefined {
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

/** Pull remote tags once, so a release made elsewhere is respected. */
function fetchTags(): void {
  git(["fetch", "--tags", "--quiet"], true);
}

function readPackageVersion(pkgPath: string): [number, number, number] {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  return parseSemver(pkg.version ?? "") ?? [0, 0, 0];
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
  .action(
    (opts: {
      level: Level;
      prefix: string;
      sibling: Sibling[];
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

      const siblings = opts.sibling.map((s) => ({ ...s, pkgPath: resolve(s.dir, "package.json") }));
      for (const s of siblings) {
        if (!existsSync(s.pkgPath)) throw new Error(`--sibling ${s.dir}: no package.json there`);
      }

      // Synth first so the release commit captures an up-to-date tree (generated
      // manifests, workspace file, tasks, ...) rather than a stale one.
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

      // Base = highest of the local package version and the latest tag in EVERY
      // namespace being released, so one shared version stays ahead of them all.
      fetchTags();
      const prefixes = [opts.prefix, ...siblings.map((s) => s.prefix)];
      const tagged = prefixes
        .map((prefix) => ({ prefix, version: latestTagVersion(prefix) }))
        .filter((t): t is { prefix: string; version: [number, number, number] } => !!t.version);
      const base = tagged.reduce(
        (highest, t) => (compareSemver(t.version, highest) > 0 ? t.version : highest),
        readPackageVersion(pkgPath),
      );
      const next = increment(base, opts.level);
      const version = next.join(".");
      const tags = prefixes.map((prefix) => `${prefix}${version}`);
      logger.info(
        `bump ${base.join(".")} -> ${version} (${opts.level}); tags ${tags.join(", ")}` +
          `${tagged.length ? "" : " [no remote tag]"}`,
      );
      for (const t of tagged) {
        if (compareSemver(t.version, base) < 0) {
          logger.info(`${t.prefix}* was behind at ${t.version.join(".")}, catching it up`);
        }
      }

      const push = opts.push && opts.publish;

      if (opts.version) {
        writeManifestVersion(pkgPath, version);
        for (const s of siblings) writeManifestVersion(s.pkgPath, version);
        const also = siblings.length ? ` (and ${siblings.map((s) => s.dir).join(", ")})` : "";
        logger.info(`wrote version ${version} to package.json${also}`);
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
      if (publishToLocalRegistry) {
        logger.info(`publishing ${version} to local registry ${localRegistry}`);
        // Mirror the CI `release` workflow via the shared publish task: it sets
        // the release version on every workspace member (`bun pm pkg set`; they
        // keep `0.0.0` on disk, projen-owned, so it unlocks each briefly), then
        // `bun publish`es each non-private one - and bun natively strips the
        // `workspace:`/`catalog:` protocols in the packed tarball, resolving each
        // to the version just set. `publish.ts` restores every manifest it touched
        // at exit, so this leaves the worktree matching the release commit that was
        // just pushed - the release version lives in the git tag, not on disk.
        // Provenance is off for a local registry (no OIDC), so
        // `NPM_CONFIG_PROVENANCE` is unset.
        // `publish.ts` is this task's SIBLING in the engine's `tasks/` dir; resolve
        // it off `import.meta.url` (works whether the engine is source-linked in-repo
        // or installed under node_modules) rather than a repo-relative `tasks/...`
        // that only exists inside `projen/`.
        const publishScript = fileURLToPath(new URL("./publish.ts", import.meta.url));
        exec.spawnSync("bun", [publishScript, version, "--registry", localRegistry], {
          cwd: process.cwd(),
          stdout: "inherit",
          stderr: "inherit",
          stdin: "ignore",
          check: true,
        });
        logger.success(`published ${version} to ${localRegistry}`);
      }

      // Publishing can run package lifecycle hooks, including a standalone
      // project's own projen synth, which rewrites its generated manifest back
      // to 0.0.0. Re-assert the release version last so root and every sibling
      // manifest finish the bump in lockstep.
      if (opts.version) {
        writeManifestVersion(pkgPath, version);
        for (const s of siblings) writeManifestVersion(s.pkgPath, version);
        logger.info(`synchronized release manifests at ${version}`);
      }
    },
  );

await program.parseAsync();
