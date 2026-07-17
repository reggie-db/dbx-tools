/**
 * Release wiring: registers the `bump` task on a project (compute next version +
 * commit + tag + push), parameterized by the project's git tag prefix, and - when
 * the project has a GitHub component - authors the tag-driven npm publish
 * workflow that the pushed tag triggers.
 */
import { Component } from "projen";
import { GithubWorkflow } from "projen/lib/github";
import { JobPermission } from "projen/lib/github/workflows-model";
import { applyTasks, taskScript, type DBXToolsNodeProject } from "./project";

/**
 * A standalone project that lives in a repo SUBDIRECTORY but is NOT a member of
 * this pnpm workspace (e.g. the `@dbx-tools/projen` engine in `projen/`), yet
 * still needs a release workflow. GitHub Actions only runs workflows from the
 * REPO-ROOT `.github/`, so the workflow for such a project is authored here,
 * alongside the root's own `release` workflow, under a distinct name + tag
 * prefix so the two never collide. Tag-driven and pack-based: push
 * `<tagPrefix>1.2.3` and the single package in `directory` is published at 1.2.3
 * via `npm pack` + `npm publish`.
 */
export interface StandaloneRelease {
  /** Workflow name (and `.github/workflows/<name>.yml` file). E.g. `projen-release`. */
  readonly name: string;
  /** Repo-relative directory of the standalone project. E.g. `projen`. */
  readonly directory: string;
  /**
   * Git tag prefix that triggers this release, disjoint from the root's `v*`
   * (e.g. `projen-v`). The pushed tag IS the published version.
   */
  readonly tagPrefix: string;
}

/** Options for {@link DBXToolsRelease}. */
export interface DBXToolsReleaseOptions {
  /**
   * Git tag prefix for this project's releases (e.g. `v` or `projen-v`). The
   * `bump` task reads/writes `<prefix><version>` tags, keeping sibling projects
   * in the same repo on disjoint tag namespaces. Defaults to `v`.
   */
  readonly tagPrefix?: string;
  /**
   * Standalone in-repo projects (NOT workspace members) that each get their own
   * tag-driven release workflow authored alongside the root's - see
   * {@link StandaloneRelease}. Authored only when the project has a GitHub
   * component. Defaults to none.
   */
  readonly standaloneReleases?: readonly StandaloneRelease[];
}

/**
 * Adds a `bump` task: compute the next release version (from the higher of the
 * latest `<prefix>*` git tag and the local `package.json`), then commit, tag,
 * and push it - pushing the tag is what triggers the release workflow. Each step
 * is toggleable (`--no-version` / `--no-commit` / `--no-tag` / `--no-push` /
 * `--no-publish`); see `tasks/bump.ts`.
 *
 * When the project has a GitHub component (`github: true`), also authors the
 * `release` workflow: on a pushed `<prefix>*` tag it sets that version on every
 * publishable workspace package and runs `pnpm -r publish` (which skips
 * `private` packages and honors each package's `publishConfig`).
 *
 * Provenance is opt-in. Each package's generated `publishConfig` omits
 * `provenance`, so LOCAL publishes (e.g. to a verdaccio) never try to attest -
 * npm has no CI OIDC provider off-CI and would fail with `provider: null`. This
 * CI workflow turns it on with `npm_config_provenance=true`, backed by the
 * `id-token: write` permission that lets npm mint the OIDC token.
 */
export class DBXToolsRelease extends Component {
  private readonly tagPrefix: string;
  private readonly standaloneReleases: readonly StandaloneRelease[];

  constructor(project: DBXToolsNodeProject, options: DBXToolsReleaseOptions = {}) {
    super(project);
    this.tagPrefix = options.tagPrefix ?? "v";
    this.standaloneReleases = options.standaloneReleases ?? [];
  }

  public override preSynthesize(): void {
    const project = this.project as DBXToolsNodeProject;
    applyTasks(project, {
      bump: {
        exec: taskScript(project, "bump.ts", `--prefix ${this.tagPrefix}`),
        receiveArgs: true,
        description:
          "Bump the release version (default patch), then commit, tag, and push it",
      },
    });

    // Author the tag-driven publish workflows only when GitHub is enabled - they
    // live in `.github/`, which requires projen's GitHub component.
    if (project.github) {
      this.authorReleaseWorkflow(project);
      for (const standalone of this.standaloneReleases) {
        this.authorStandaloneReleaseWorkflow(project, standalone);
      }
    }
  }

  /**
   * Emit the `release` GitHub workflow: push `<prefix>1.2.3` and every
   * publishable workspace package is published to npm at 1.2.3. Setting the
   * version on every package first makes the pushed tag the published version
   * (no bump math).
   */
  private authorReleaseWorkflow(project: DBXToolsNodeProject): void {
    const workflow = new GithubWorkflow(project.github!, "release");
    workflow.on({ push: { tags: [`${this.tagPrefix}*`] } });
    workflow.addJob("publish", {
      runsOn: ["ubuntu-latest"],
      // `id-token: write` lets npm mint the OIDC token for provenance attestation.
      permissions: { contents: JobPermission.READ, idToken: JobPermission.WRITE },
      env: { CI: "true" },
      steps: [
        { name: "Checkout", uses: "actions/checkout@v6", with: { "fetch-depth": 0 } },
        { name: "Setup pnpm", uses: "pnpm/action-setup@v5", with: { version: "10.33.0" } },
        {
          name: "Setup Node.js",
          uses: "actions/setup-node@v6",
          with: { "node-version": "lts/*", "registry-url": "https://registry.npmjs.org" },
        },
        { name: "Install", run: "pnpm install --no-frozen-lockfile" },
        // The pushed tag is the version: `<prefix>1.2.3` -> `1.2.3`. Set it on
        // every package (manifests are projen-readonly, so unlock them first).
        {
          name: "Set version from tag",
          run: [
            `VERSION="\${GITHUB_REF_NAME#${this.tagPrefix}}"`,
            "chmod -R u+w . || true",
            'pnpm -r exec npm version "$VERSION" --no-git-tag-version --allow-same-version',
          ].join("\n"),
        },
        {
          name: "Publish to npm",
          // `pnpm -r publish` publishes every non-private workspace package,
          // rewriting `workspace:*` deps to the published version. Provenance is
          // opt-in (omitted from each package's `publishConfig` so local
          // publishes work); CI turns it on here via `npm_config_provenance`.
          run: "pnpm -r publish --no-git-checks --access public",
          env: {
            NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
            npm_config_provenance: "true",
          },
        },
      ],
    });
  }

  /**
   * Emit a {@link StandaloneRelease}'s workflow: push `<prefix>1.2.3` and the
   * single package in `directory` (a non-workspace-member project) is published
   * at 1.2.3 via `npm pack` + `npm publish`. Its `package.json` is
   * projen-generated read-only, so it is unlocked before `npm version` rewrites
   * it. No bump math - the pushed tag IS the published version.
   */
  private authorStandaloneReleaseWorkflow(
    project: DBXToolsNodeProject,
    { name, directory, tagPrefix }: StandaloneRelease,
  ): void {
    const workflow = new GithubWorkflow(project.github!, name);
    workflow.on({ push: { tags: [`${tagPrefix}*`] } });
    workflow.addJob("publish", {
      runsOn: ["ubuntu-latest"],
      // `id-token: write` lets npm mint the OIDC token for provenance attestation.
      permissions: { contents: JobPermission.READ, idToken: JobPermission.WRITE },
      defaults: { run: { workingDirectory: directory } },
      env: { CI: "true" },
      steps: [
        { name: "Checkout", uses: "actions/checkout@v6", with: { "fetch-depth": 0 } },
        { name: "Setup pnpm", uses: "pnpm/action-setup@v5", with: { version: "10.33.0" } },
        {
          name: "Setup Node.js",
          uses: "actions/setup-node@v6",
          with: { "node-version": "lts/*", "registry-url": "https://registry.npmjs.org" },
        },
        { name: "Install", run: "pnpm install --no-frozen-lockfile" },
        // The pushed tag is the version: `<prefix>1.2.3` -> `1.2.3`. package.json
        // is projen-generated read-only, so unlock it before `npm version` writes.
        {
          name: "Set version from tag",
          run: [
            "chmod u+w package.json",
            `npm version "\${GITHUB_REF_NAME#${tagPrefix}}" --no-git-tag-version --allow-same-version`,
          ].join("\n"),
        },
        { name: "Pack", run: "pnpm pack --pack-destination dist/js" },
        {
          name: "Publish to npm",
          run: "npm publish dist/js/*.tgz --access public",
          env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" },
        },
      ],
    });
  }
}
