/**
 * Release and publish: bump version, commit, tag, push (triggers CI), plus projen
 * wiring when `release` is enabled. Lock/unlock of generated `package.json` files
 * is internal only.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Component } from "projen";
import { runPnpm } from "dbx-tools/bin";
import { logger } from "dbx-tools/log";
import { makeReadonly, makeWritable } from "./generated";
import { type DBXToolsNodeProject } from "./project";
import { taskScript } from "./task-script";
import { repoRoot, toPosix, workspacePackages } from "./workspace";

/** Forced semver bump level when conventional-commit inference is overridden. */
export type BumpLevel = "patch" | "minor" | "major";

type PublishManifest = { private?: boolean; publishConfig?: unknown };

const log = logger.withTag("projen:publish");

const FORCE_BUMP_HINT = "use --increment minor or --increment major for a larger bump";

function runProjenBumpVersion(env: Record<string, string>): void {
  const require = createRequire(import.meta.url);
  const scriptPath = require.resolve("projen/lib/release/bump-version.task.js");
  execFileSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...env },
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
  const stdout = execFileSync(
    "git",
    ["-c", "versionsort.suffix=-", "tag", "--sort=-version:refname", "--list", "v*"],
    { cwd, encoding: "utf8" },
  ).trim();
  return stdout
    .split("\n")
    .find((t) => t.trim())
    ?.trim();
}

function versionFromTag(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function gitHead(cwd: string = repoRoot): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

/** Repo-relative path to the npm-publishable workspace package. */
export function findPublishRelPath(root: string = repoRoot): string {
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
  runPnpm([
    "--dir",
    publishRelPath,
    "pack",
    "--pack-destination",
    packDestinationArg(publishRelPath),
  ]);
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
    runPnpm(["exec", "projen", "build"]);
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
    execFileSync("git", ["add", ...manifests], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    execFileSync("git", ["commit", "-m", `chore(release): ${version}`], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    const sha = gitHead();
    execFileSync("git", ["push", "origin", "HEAD"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    const tag = readFileSync(join(repoRoot, "dist/releasetag.txt"), "utf8").trim();
    if (!tag) throw new Error("dist/releasetag.txt is empty");
    const changelog = join(repoRoot, "dist/changelog.md");
    execFileSync("git", ["tag", tag, "-a", "-F", changelog, sha], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    execFileSync("git", ["push", "origin", tag], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  });
}

/**
 * Root release wiring when `release` is enabled. Adds a `publish` task and
 * retargets `compile` / `package` / `release:tag` for the engine publish flow.
 */
export function configureRelease(project: DBXToolsNodeProject): void {
  if (!project.release) return;

  try {
    findPublishRelPath(project.outdir);
  } catch {
    return;
  }

  if (!project.tasks.tryFind("release:tag")) {
    project.compileTask.reset("pnpm -r compile");
    project.packageTask.reset(taskScript(project, "publish.ts", "--pack"));
    const publishTask =
      project.tasks.tryFind("publish") ??
      project.addTask("publish", {
        description: "Bump version (default patch), commit, push branch, tag, and push tag",
      });
    publishTask.reset(taskScript(project, "publish.ts"), {
      receiveArgs: true,
    });
    project.addTask("release:tag", {
      description: "CI: build and pack from the git tag that triggered the workflow",
      exec: taskScript(project, "publish.ts", "--ci"),
    });
  }

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
