/**
 * Release and publish: bump version, commit, tag, push (triggers CI), plus projen
 * wiring when `release` is enabled. Lock/unlock of generated `package.json` files
 * is internal only.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { exec } from "@dbx-tools/node-core";
import { Component } from "projen";
import { makeReadonly, makeWritable } from "./generated";
import { logger } from "./log";
import { applyTasks, taskScript, type DBXToolsNodeProject } from "./project";
import { repoRoot, toPosix, workspacePackages } from "./workspace";

/** Forced semver bump level when conventional-commit inference is overridden. */
export type BumpLevel = "patch" | "minor" | "major";

type PublishManifest = { private?: boolean; publishConfig?: unknown };

const log = logger.withTag("projen:publish");

const FORCE_BUMP_HINT = "use --increment minor or --increment major for a larger bump";

function runProjenBumpVersion(env: Record<string, string>): void {
  const require = createRequire(import.meta.url);
  const scriptPath = require.resolve("projen/lib/release/bump-version.task.js");
  exec.spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    check: true,
  });
}

function bumpVersionEnv(bumpLevel: BumpLevel): Record<string, string> {
  return {
    OUTFILE: "package.json",
    CHANGELOG: "dist/changelog.md",
    BUMPFILE: "dist/version.txt",
    RELEASETAG: "dist/releasetag.txt",
    RELEASE_TAG_PREFIX: "",
    BUMP_PACKAGE: "commit-and-tag-version@^12",
    NEXT_VERSION_COMMAND: `${process.execPath} -e process.stdout.write(${JSON.stringify(bumpLevel)})`,
  };
}

/** Highest `v*` release tag (version-sorted), matching projen's bump lookup. */
function latestReleaseTag(cwd: string = repoRoot): string | undefined {
  const { stdout } = exec.spawnSync(
    "git",
    ["-c", "versionsort.suffix=-", "tag", "--sort=-version:refname", "--list", "v*"],
    { cwd, stdout: "capture", stderr: "ignore", stdin: "ignore", check: true },
  );
  return stdout
    .split("\n")
    .find((t) => t.trim())
    ?.trim();
}

function versionFromTag(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function gitHead(cwd: string = repoRoot): string {
  const { stdout } = exec.spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    stdout: "capture",
    stderr: "ignore",
    stdin: "ignore",
    check: true,
  });
  return stdout;
}

/** Repo-relative path to the npm-publishable workspace package. */
function findPublishRelPath(root: string = repoRoot): string {
  for (const pkg of workspacePackages(root)) {
    const manifest = JSON.parse(
      readFileSync(join(pkg.dir, "package.json"), "utf8"),
    ) as PublishManifest;
    if (manifest.private) continue;
    if (manifest.publishConfig) return toPosix(relative(root, pkg.dir));
  }
  for (const pkg of workspacePackages(root)) {
    const manifest = JSON.parse(
      readFileSync(join(pkg.dir, "package.json"), "utf8"),
    ) as PublishManifest;
    if (!manifest.private) return toPosix(relative(root, pkg.dir));
  }
  throw new Error("no publishable workspace package found");
}

function manifestPaths(publishRelPath: string): string[] {
  return ["package.json", `${publishRelPath}/package.json`];
}

function withUnlockedManifests<T>(publishRelPath: string, fn: () => T): T {
  const manifests = manifestPaths(publishRelPath);
  for (const path of manifests) makeWritable(path);
  try {
    return fn();
  } finally {
    for (const path of manifests) makeReadonly(path);
  }
}

function syncPublishVersion(publishRelPath: string): void {
  const pkgPath = `${publishRelPath}/package.json`;
  const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
    .version as string;
  const pkg = JSON.parse(readFileSync(join(repoRoot, pkgPath), "utf8")) as {
    version?: string;
  };
  pkg.version = version;
  writeFileSync(join(repoRoot, pkgPath), `${JSON.stringify(pkg, null, 2)}\n`);
}

function packDestinationArg(publishRelPath: string): string {
  const depth = publishRelPath.split("/").filter(Boolean).length;
  return `${"../".repeat(depth)}dist/js`;
}

/** Sync version and `pnpm pack` the publishable package into `dist/js` (CI package step). */
export function packForRelease(publishRelPath: string = findPublishRelPath()): void {
  syncPublishVersion(publishRelPath);
  mkdirSync(join(repoRoot, "dist/js"), { recursive: true });
  exec.spawnSync(
    "pnpm",
    ["--dir", publishRelPath, "pack", "--pack-destination", packDestinationArg(publishRelPath)],
    { cwd: repoRoot, check: true },
  );
}

/** CI: build and pack from the git tag that triggered the workflow. */
export function buildFromTag(publishRelPath: string = findPublishRelPath()): void {
  withUnlockedManifests(publishRelPath, () => {
    rmSync(join(repoRoot, "dist"), { recursive: true, force: true });
    const ref = process.env.GITHUB_REF_NAME ?? "";
    const version = ref.replace(/^v/, "");
    if (!version) throw new Error("GITHUB_REF_NAME is required");
    const rootPath = join(repoRoot, "package.json");
    const root = JSON.parse(readFileSync(rootPath, "utf8")) as {
      version?: string;
    };
    root.version = version;
    writeFileSync(rootPath, `${JSON.stringify(root, null, 2)}\n`);
    syncPublishVersion(publishRelPath);
    exec.spawnSync("pnpm", ["exec", "projen", "build"], { cwd: repoRoot, check: true });
    const tag = ref.startsWith("v") ? ref : `v${ref}`;
    mkdirSync(join(repoRoot, "dist"), { recursive: true });
    writeFileSync(join(repoRoot, "dist/releasetag.txt"), `${tag}\n`);
    writeFileSync(join(repoRoot, "dist/changelog.md"), `# ${tag}\n\nTagged release.\n`);
  });
}

/**
 * Bump version, commit manifests, push the branch, tag the pushed commit, and push
 * the tag to `origin` (triggers the release workflow).
 */
export function publish(
  publishRelPath: string = findPublishRelPath(),
  bumpLevel: BumpLevel = "patch",
): void {
  withUnlockedManifests(publishRelPath, () => {
    rmSync(join(repoRoot, "dist"), { recursive: true, force: true });
    runProjenBumpVersion(bumpVersionEnv(bumpLevel));
    const version = readFileSync(join(repoRoot, "dist/version.txt"), "utf8").trim();
    if (!version) throw new Error("dist/version.txt is empty after bump");
    const latestTag = latestReleaseTag();
    if (latestTag && versionFromTag(latestTag) === version) {
      log.info(`nothing to release: ${latestTag} is already the latest tag (${FORCE_BUMP_HINT})`);
      return;
    }
    syncPublishVersion(publishRelPath);
    const manifests = manifestPaths(publishRelPath);
    exec.spawnSync("git", ["add", ...manifests], {
      cwd: repoRoot,
      check: true,
    });
    exec.spawnSync("git", ["commit", "-m", `chore(release): ${version}`], {
      cwd: repoRoot,
      check: true,
    });
    const sha = gitHead();
    exec.spawnSync("git", ["push", "origin", "HEAD"], {
      cwd: repoRoot,
      check: true,
    });
    const tag = readFileSync(join(repoRoot, "dist/releasetag.txt"), "utf8").trim();
    if (!tag) throw new Error("dist/releasetag.txt is empty");
    const changelog = join(repoRoot, "dist/changelog.md");
    exec.spawnSync("git", ["tag", tag, "-a", "-F", changelog, sha], {
      cwd: repoRoot,
      check: true,
    });
    exec.spawnSync("git", ["push", "origin", tag], {
      cwd: repoRoot,
      check: true,
    });
  });
}

/**
 * Root release wiring when `release` is enabled. Adds a `publish` task and, when
 * `release:tag` is not yet present, retargets `compile` / `package` / `release:tag`
 * for the engine publish flow.
 */
function configureRelease(project: DBXToolsNodeProject): void {
  if (!project.release) return;

  try {
    findPublishRelPath(project.outdir);
  } catch {
    return;
  }

  if (!project.tasks.tryFind("release:tag")) {
    // `build` retargets the root `compile` task (see `applyTasks`); `package` matches
    // projen's existing package task by name, so both are reset in place.
    applyTasks(project, {
      build: { exec: "pnpm -r compile" },
      package: { exec: taskScript(project, "publish.ts", "--pack") },
      publish: {
        exec: taskScript(project, "publish.ts"),
        receiveArgs: true,
        description: "Bump version (default patch), commit, push branch, tag, and push tag",
      },
      "release:tag": {
        exec: taskScript(project, "publish.ts", "--ci"),
        description: "CI: build and pack from the git tag that triggered the workflow",
      },
    });
  }

  project.release.publisher.publishToNpm({
    npmProvenance: true,
  });

  const releaseWorkflow = project.github?.tryFindWorkflow("release");
  releaseWorkflow?.file?.addOverride("on.push.branches", undefined);
  releaseWorkflow?.file?.addOverride("on.workflow_dispatch", undefined);
  releaseWorkflow?.patchStep("release", "release", {
    run: "pnpm exec projen release:tag",
  });
  releaseWorkflow?.file?.addOverride("jobs.release_github", undefined);
  releaseWorkflow?.file?.addOverride(
    "jobs.release_npm.if",
    "${{ needs.release.outputs.latest_commit == github.sha }}",
  );
}

/** Defers {@link configureRelease} to `preSynthesize` (after publish mixins run). */
export class DBXToolsRelease extends Component {
  constructor(project: DBXToolsNodeProject) {
    super(project);
  }

  public override preSynthesize(): void {
    configureRelease(this.project as DBXToolsNodeProject);
  }
}
