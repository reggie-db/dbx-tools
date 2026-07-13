/**
 * Release tasks and GitHub workflow wiring for a monorepo root that publishes a
 * single workspace package (`@<scope>/cli` or any non-private package with
 * `publishConfig`).
 *
 * When projen `release` is enabled on the root, {@link configureRelease} adds
 * `tag`, `release:push`, and `release:tag` tasks, retargets `compile`/`package` for
 * workspace-wide type-check + `pnpm pack`, and limits the release workflow to
 * version-tag pushes, GitHub releases, and manual dispatch (never bare `main`
 * pushes). Bump/unbump temporarily unlock the locked `package.json` files first.
 */
import { relative } from "node:path";
import { Component, type Task, javascript, typescript } from "projen";
import { type DBXToolsTypeScriptProject, type DBXToolsNodeProject } from "./project";
import { toPosix } from "./workspace";

/** Repo-relative `package.json` paths made writable around bump/unbump. */
function packageJsonPaths(publishPackageRelPath?: string): string[] {
  const paths = ["package.json"];
  if (publishPackageRelPath) paths.push(`${publishPackageRelPath}/package.json`);
  return paths;
}

/** Shell: drop the write bit on generated manifests so bump can rewrite versions. */
function unlockPackageJsonExec(...manifests: string[]): string {
  return manifests.map((f) => `[ -f ${f} ] && chmod u+w ${f}`).join(" && ");
}

/** Shell: restore the read-only bit projen synth applies to generated manifests. */
function relockPackageJsonExec(...manifests: string[]): string {
  return manifests.map((f) => `[ -f ${f} ] && chmod a-w ${f}`).join(" && ");
}

/** Copy the root `version` field into the publishable workspace package. */
function syncPublishVersionExec(publishPackageRelPath: string): string {
  return `node --input-type=module -e "import { readFileSync, writeFileSync } from 'node:fs'; const version = JSON.parse(readFileSync('package.json', 'utf8')).version; const pkgPath = '${publishPackageRelPath}/package.json'; const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); pkg.version = version; writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\\n');"`;
}

/** `pnpm pack` destination under the repo root `dist/js` from a nested package path. */
function packDestinationArg(publishPackageRelPath: string): string {
  const depth = publishPackageRelPath.split("/").filter(Boolean).length;
  return `${"../".repeat(depth)}dist/js`;
}

/**
 * The npm-publishable workspace child: first non-private package that carries
 * `publishConfig` (the engine itself when dogfooded as `@dbx-tools/cli`).
 */
export function findPublishPackage(
  project: DBXToolsNodeProject,
): DBXToolsTypeScriptProject | undefined {
  const rootAbs = project.outdir;
  for (const sub of project.subprojects) {
    if (!(sub instanceof typescript.TypeScriptProject)) continue;
    const manifest = sub.package.manifest as { private?: boolean; publishConfig?: unknown };
    if (manifest.private) continue;
    if (manifest.publishConfig) return sub as DBXToolsTypeScriptProject;
  }
  for (const sub of project.subprojects) {
    if (sub instanceof typescript.TypeScriptProject) {
      const manifest = sub.package.manifest as { private?: boolean };
      if (!manifest.private) return sub as DBXToolsTypeScriptProject;
    }
  }
  return undefined;
}

/** Wrap `bump`/`unbump` so they can rewrite locked `package.json` files at runtime. */
function unlockBumpTasks(
  bumpTask: Task,
  unbumpTask: Task,
  manifests: string[],
  releaseTask?: Task,
): void {
  const unlock = unlockPackageJsonExec(...manifests);
  const relock = relockPackageJsonExec(...manifests);
  bumpTask.prependExec(unlock);
  unbumpTask.prependExec(unlock);
  if (releaseTask) releaseTask.exec(relock);
}

/**
 * Root release wiring: tasks + GitHub workflow triggers. No-op when `release` was
 * not enabled on the root or no publishable package exists yet.
 */
export function configureRelease(project: DBXToolsNodeProject): void {
  if (!project.release) return;
  // Mixins (e.g. publishConfig) run after the root constructor; preSynthesize is
  // late enough to discover the publishable package, and this guard keeps a re-synth
  // from duplicating tasks or bump unlock steps.
  if (project.tasks.tryFind("tag")) return;

  const publishPkg = findPublishPackage(project);
  if (!publishPkg) return;

  const publishRelPath = toPosix(relative(project.outdir, publishPkg.outdir));
  const manifests = packageJsonPaths(publishRelPath);
  const syncVersion = syncPublishVersionExec(publishRelPath);
  const packDest = packDestinationArg(publishRelPath);

  project.compileTask.reset("pnpm -r compile");
  project.packageTask.reset(
    `${syncVersion} && mkdir -p dist/js && pnpm --dir ${publishRelPath} pack --pack-destination ${packDest}`,
  );

  const bumpTask = project.tasks.tryFind("bump");
  const unbumpTask = project.tasks.tryFind("unbump");
  const releaseTask = project.tasks.tryFind("release");
  if (!bumpTask || !unbumpTask) {
    throw new Error("release is enabled but projen bump/unbump tasks are missing");
  }
  unlockBumpTasks(bumpTask, unbumpTask, manifests, releaseTask ?? undefined);

  const tagTask = project.addTask("tag", {
    description: "Bump version, generate a changelog message, and tag HEAD",
  });
  tagTask.prependExec(unlockPackageJsonExec(...manifests));
  tagTask.exec("rm -fr dist");
  tagTask.spawn(bumpTask);
  tagTask.exec(syncVersion);
  tagTask.env("CHANGELOG", "dist/changelog.md");
  tagTask.env("RELEASE_TAG_FILE", "dist/releasetag.txt");
  tagTask.builtin("release/tag-version");
  tagTask.spawn(unbumpTask);
  tagTask.exec(`git checkout -- ${manifests.join(" ")}`);

  const releasePushTask = project.addTask("release:push", {
    description: "Tag, push the release tag, and let CI publish on tag push",
  });
  releasePushTask.spawn(tagTask);
  releasePushTask.exec('git push origin "$(cat dist/releasetag.txt)"');

  const releaseTagTask = project.addTask("release:tag", {
    description: "Build and pack from the git tag that triggered CI",
  });
  releaseTagTask.exec("rm -fr dist");
  releaseTagTask.prependExec(unlockPackageJsonExec(...manifests));
  releaseTagTask.exec(
    `node --input-type=module -e "import { readFileSync, writeFileSync } from 'node:fs'; const ref = process.env.GITHUB_REF_NAME ?? ''; const version = ref.replace(/^v/, ''); if (!version) throw new Error('GITHUB_REF_NAME is required'); const root = JSON.parse(readFileSync('package.json', 'utf8')); root.version = version; writeFileSync('package.json', JSON.stringify(root, null, 2) + '\\n');"`,
  );
  releaseTagTask.exec(syncVersion);
  releaseTagTask.spawn(project.buildTask);
  releaseTagTask.exec(
    `node --input-type=module -e "import { writeFileSync } from 'node:fs'; const ref = process.env.GITHUB_REF_NAME ?? ''; if (!ref) throw new Error('GITHUB_REF_NAME is required'); const tag = ref.startsWith('v') ? ref : \`v\${ref}\`; writeFileSync('dist/releasetag.txt', tag + '\\n'); writeFileSync('dist/changelog.md', '# ' + tag + '\\n\\nTagged release.\\n');"`,
  );
  releaseTagTask.exec(relockPackageJsonExec(...manifests));

  const releaseWorkflow = project.github?.tryFindWorkflow("release");
  releaseWorkflow?.on({
    push: { tags: ["v*"] },
    release: { types: ["published"] },
  });
  releaseWorkflow?.patchStep("release", "release", {
    run: 'if [ "${{ github.ref_type }}" = "tag" ]; then pnpm exec projen release:tag; else pnpm exec projen release; fi',
  });
  const publishIf =
    "(github.ref_type == 'tag' || needs.release.outputs.tag_exists != 'true') && needs.release.outputs.latest_commit == github.sha";
  releaseWorkflow?.file?.addOverride("jobs.release_github.if", publishIf);
  releaseWorkflow?.file?.addOverride("jobs.release_npm.if", publishIf);
}

/**
 * Defers {@link configureRelease} to `preSynthesize` so caller mixins have already
 * marked the npm-publishable workspace package (`publishConfig`, `private`, …).
 */
export class DBXToolsRelease extends Component {
  constructor(project: DBXToolsNodeProject) {
    super(project);
  }

  public override preSynthesize(): void {
    configureRelease(this.project as DBXToolsNodeProject);
  }
}
