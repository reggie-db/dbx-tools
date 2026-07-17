/**
 * Release wiring: registers the `bump` task on a project (compute next version +
 * commit + tag + push), parameterized by the project's git tag prefix. The
 * actual npm publish happens in a GitHub workflow triggered by the pushed tag
 * (authored in each project's `.projenrc`), not here.
 */
import { Component } from "projen";
import { applyTasks, taskScript, type DBXToolsNodeProject } from "./project";

/** Options for {@link DBXToolsRelease}. */
export interface DBXToolsReleaseOptions {
  /**
   * Git tag prefix for this project's releases (e.g. `v` or `projen-v`). The
   * `bump` task reads/writes `<prefix><version>` tags, keeping sibling projects
   * in the same repo on disjoint tag namespaces. Defaults to `v`.
   */
  readonly tagPrefix?: string;
}

/**
 * Adds a `bump` task: compute the next release version (from the higher of the
 * latest `<prefix>*` git tag and the local `package.json`), then commit, tag,
 * and push it - pushing the tag is what triggers the release workflow. Each step
 * is toggleable (`--no-version` / `--no-commit` / `--no-tag` / `--no-push` /
 * `--no-publish`); see `tasks/bump.ts`.
 */
export class DBXToolsRelease extends Component {
  private readonly tagPrefix: string;

  constructor(project: DBXToolsNodeProject, options: DBXToolsReleaseOptions = {}) {
    super(project);
    this.tagPrefix = options.tagPrefix ?? "v";
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
  }
}
