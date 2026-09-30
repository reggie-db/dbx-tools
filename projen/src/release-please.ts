/**
 * Release Please integration for Projen-owned polyglot release units.
 *
 * Release Please remains responsible for semantic version selection, release
 * pull requests, tags, and GitHub Releases. This plugin contributes only the
 * dependency propagation encoded by the generated release-unit graph.
 *
 * @module
 */

import type { Commit } from "release-please/build/src/commit.js";
import type {
  CandidateReleasePullRequest,
  RepositoryConfig,
} from "release-please/build/src/manifest.js";
import { ManifestPlugin } from "release-please/build/src/plugin.js";
import type { Release } from "release-please/build/src/release.js";
import type { Scm } from "release-please/build/src/scm.js";
import type { Strategy } from "release-please/build/src/strategy.js";
import { CompositeUpdater } from "release-please/build/src/updaters/composite.js";
import { ReleasePleaseManifest } from "release-please/build/src/updaters/release-please-manifest.js";
import { BranchName } from "release-please/build/src/util/branch-name.js";
import { PullRequestBody } from "release-please/build/src/util/pull-request-body.js";
import { PullRequestTitle } from "release-please/build/src/util/pull-request-title.js";
import { Version } from "release-please/build/src/version.js";
import { PatchVersionUpdate } from "release-please/build/src/versioning-strategy.js";
import { satisfies, validRange } from "semver";
import type { ReleaseDependencyEdge, ReleaseUnit, ReleaseUnitGraph } from "./release-catalog.ts";

/** Options for {@link ReleaseUnitWorkspacePlugin}. */
export interface ReleaseUnitWorkspacePluginOptions {
  readonly graph: ReleaseUnitGraph;
  readonly manifestPath?: string;
  readonly merge?: boolean;
}

/**
 * Propagate Release Please candidates through the cross-language release graph.
 *
 * Direct candidates retain the semantic increment selected from their commits.
 * A dependent introduced only by graph propagation receives a patch.
 */
export class ReleaseUnitWorkspacePlugin extends ManifestPlugin {
  private readonly graph: ReleaseUnitGraph;
  private readonly manifestPath: string;
  private readonly merge: boolean;
  private strategiesByPath: Record<string, Strategy> = {};
  private releasesByPath: Record<string, Release> = {};

  constructor(
    github: Scm,
    targetBranch: string,
    repositoryConfig: RepositoryConfig,
    options: ReleaseUnitWorkspacePluginOptions,
  ) {
    super(github, targetBranch, repositoryConfig);
    this.graph = options.graph;
    this.manifestPath = options.manifestPath ?? ".release-please-manifest.json";
    this.merge = options.merge ?? true;
  }

  public override async run(
    candidates: CandidateReleasePullRequest[],
  ): Promise<CandidateReleasePullRequest[]> {
    const unitsById = new Map(this.graph.units.map((unit) => [unit.id, unit]));
    const unitsByPath = new Map(this.graph.units.map((unit) => [releaseUnitPath(unit), unit]));
    const inScope: CandidateReleasePullRequest[] = [];
    const outOfScope: CandidateReleasePullRequest[] = [];
    const versions = new Map<string, Version>();
    const direct = new Set<string>();

    for (const candidate of candidates) {
      const unit = unitsByPath.get(candidate.path);
      if (!unit || !candidate.pullRequest.version) {
        outOfScope.push(candidate);
        continue;
      }
      inScope.push(candidate);
      direct.add(unit.id);
      versions.set(unit.id, candidate.pullRequest.version);
    }
    if (inScope.length === 0) return candidates;

    const queue = [...direct];
    const propagated = new Set<string>();
    while (queue.length > 0) {
      const changed = queue.shift()!;
      const changedVersion = versions.get(changed);
      if (!changedVersion) continue;
      for (const edge of this.graph.edges.filter((candidate) => candidate.to === changed)) {
        if (!shouldPropagate(edge, changedVersion, unitsById.get(changed))) continue;
        if (versions.has(edge.from)) continue;
        const dependent = unitsById.get(edge.from);
        if (!dependent) throw new Error(`Release graph references unknown unit ${edge.from}`);
        versions.set(dependent.id, new PatchVersionUpdate().bump(Version.parse(dependent.version)));
        propagated.add(dependent.id);
        queue.push(dependent.id);
      }
    }

    for (const id of propagated) {
      const unit = unitsById.get(id)!;
      inScope.push(await this.newCandidate(unit, versions.get(id)!));
    }

    const merged = this.merge ? mergeCandidates(inScope, this.targetBranch) : inScope;
    const manifestVersions = new Map(
      [...versions].map(([id, version]) => {
        const unit = unitsById.get(id);
        if (!unit) throw new Error(`Release version resolved for unknown unit ${id}`);
        return [releaseUnitPath(unit), version] as const;
      }),
    );
    const first = merged[0];
    if (first) {
      const manifestVersion = versions.values().next().value;
      if (!manifestVersion) throw new Error("Release Please resolved no component versions");
      const updater = new ReleasePleaseManifest({
        version: manifestVersion,
        versionsMap: manifestVersions,
      });
      const existing = first.pullRequest.updates.find(
        (update) => update.path === this.manifestPath,
      );
      if (existing) {
        existing.updater = new CompositeUpdater(existing.updater, updater);
      } else {
        first.pullRequest.updates.push({
          path: this.manifestPath,
          createIfMissing: false,
          updater,
        });
      }
    }
    return [...outOfScope, ...merged];
  }

  public override async preconfigure(
    strategiesByPath: Record<string, Strategy>,
    _commitsByPath: Record<string, Commit[]>,
    releasesByPath: Record<string, Release>,
  ): Promise<Record<string, Strategy>> {
    this.strategiesByPath = strategiesByPath;
    this.releasesByPath = releasesByPath;
    return strategiesByPath;
  }

  private async newCandidate(
    unit: ReleaseUnit,
    version: Version,
  ): Promise<CandidateReleasePullRequest> {
    const path = releaseUnitPath(unit);
    const strategy = this.strategiesByPath[path];
    if (!strategy) throw new Error(`Release Please strategy not found for ${path}`);
    const pullRequest = await strategy.buildReleasePullRequest(
      [],
      this.releasesByPath[path],
      false,
      [],
      { newVersion: version },
    );
    if (!pullRequest) throw new Error(`Release Please did not build a candidate for ${unit.id}`);
    return {
      path,
      pullRequest,
      config: this.repositoryConfig[path] ?? { releaseType: "simple" },
    };
  }
}

/** Attach graph propagation to a Release Please manifest instance. */
export function addReleaseUnitPlugin(
  plugins: ManifestPlugin[],
  github: Scm,
  targetBranch: string,
  repositoryConfig: RepositoryConfig,
  graph: ReleaseUnitGraph,
  manifestPath?: string,
): void {
  plugins.push(
    new ReleaseUnitWorkspacePlugin(github, targetBranch, repositoryConfig, {
      graph,
      manifestPath,
    }),
  );
}

/** Stable synthetic component path consumed by Release Please. */
export function releaseUnitPath(unit: Pick<ReleaseUnit, "component">): string {
  return `.release-units/${unit.component}`;
}

function shouldPropagate(
  edge: ReleaseDependencyEdge,
  newVersion: Version,
  dependency: ReleaseUnit | undefined,
): boolean {
  if (edge.propagation === "never") return false;
  if (edge.propagation === "always") return true;
  if (!edge.requirement || !dependency) return true;
  let requirement = edge.requirement;
  if (requirement.startsWith("workspace:")) {
    const workspaceRange = requirement.slice("workspace:".length);
    if (workspaceRange === "*") return true;
    requirement = workspaceRange ? `${workspaceRange}${dependency.version}` : dependency.version;
  }
  requirement = requirement.replace(/^==/, "=").replaceAll(",", " ");
  if (!validRange(requirement)) return true;
  return !satisfies(newVersion.toString(), requirement, { includePrerelease: true });
}

function mergeCandidates(
  candidates: CandidateReleasePullRequest[],
  targetBranch: string,
): CandidateReleasePullRequest[] {
  if (candidates.length <= 1) return candidates;
  const releaseData = candidates.flatMap((candidate) => candidate.pullRequest.body.releaseData);
  const labels = [...new Set(candidates.flatMap((candidate) => candidate.pullRequest.labels))];
  const rawUpdates = candidates.flatMap((candidate) => candidate.pullRequest.updates);
  const updatesByPath = new Map<string, (typeof rawUpdates)[number]>();
  for (const update of rawUpdates) {
    const current = updatesByPath.get(update.path);
    updatesByPath.set(update.path, {
      ...update,
      updater: current ? new CompositeUpdater(current.updater, update.updater) : update.updater,
    });
  }
  return [
    {
      path: ".",
      pullRequest: {
        title: PullRequestTitle.ofTargetBranch(targetBranch),
        body: new PullRequestBody(releaseData, { useComponents: true }),
        updates: [...updatesByPath.values()],
        labels,
        headRefName: BranchName.ofTargetBranch(targetBranch).toString(),
        draft: !candidates.some((candidate) => !candidate.pullRequest.draft),
      },
      config: { releaseType: "simple" },
    },
  ];
}
