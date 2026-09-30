import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  CandidateReleasePullRequest,
  RepositoryConfig,
} from "release-please/build/src/manifest.js";
import type { Scm } from "release-please/build/src/scm.js";
import type { Strategy } from "release-please/build/src/strategy.js";
import { BranchName } from "release-please/build/src/util/branch-name.js";
import { PullRequestBody } from "release-please/build/src/util/pull-request-body.js";
import { PullRequestTitle } from "release-please/build/src/util/pull-request-title.js";
import { Version } from "release-please/build/src/version.js";

import type { ReleaseUnitGraph } from "../src/release-catalog.ts";
import { ReleaseUnitWorkspacePlugin } from "../src/release-please.ts";
import { parseGitHubRepository } from "../tasks/release-please.ts";

const REPOSITORY_CONFIG: RepositoryConfig = {
  ".release-units/node-core": {
    releaseType: "simple",
    component: "node-core",
    packageName: "node-core",
  },
  ".release-units/node-app": {
    releaseType: "simple",
    component: "node-app",
    packageName: "node-app",
  },
};

const GRAPH: ReleaseUnitGraph = {
  schemaVersion: 1,
  mode: "independent",
  units: [
    {
      id: "node-app",
      component: "node-app",
      version: "2.0.0",
      projects: ["packages/app"],
      artifacts: [],
      sourceHash: "a".repeat(64),
    },
    {
      id: "node-core",
      component: "node-core",
      version: "1.0.0",
      projects: ["packages/core"],
      artifacts: [],
      sourceHash: "b".repeat(64),
    },
  ],
  projects: [],
  artifacts: [],
  edges: [
    {
      from: "node-app",
      to: "node-core",
      kind: "generated",
      propagation: "always",
      publishOrder: true,
    },
  ],
  publishBatches: [["node-core"], ["node-app"]],
};

function pullRequest(component: string, version: Version) {
  return {
    title: PullRequestTitle.ofTargetBranch("main"),
    body: new PullRequestBody([{ component, version, notes: "" }]),
    updates: [],
    labels: [],
    headRefName: BranchName.ofTargetBranch("main").toString(),
    version,
    draft: false,
  };
}

describe("ReleaseUnitWorkspacePlugin", () => {
  it("resolves GitHub SSH aliases without requiring github.com in the remote", () => {
    assert.deepEqual(parseGitHubRepository("git@github-reggie-db:reggie-db/dbx-tools.git"), {
      owner: "reggie-db",
      repo: "dbx-tools",
    });
  });

  it("keeps direct semantic bumps and gives propagated dependents a patch", async () => {
    const plugin = new ReleaseUnitWorkspacePlugin({} as Scm, "main", REPOSITORY_CONFIG, {
      graph: GRAPH,
    });
    const appStrategy = {
      buildReleasePullRequest: async (
        _commits: unknown,
        _release: unknown,
        _draft: unknown,
        _labels: unknown,
        options: { newVersion: Version },
      ) => pullRequest("node-app", options.newVersion),
    } as unknown as Strategy;
    await plugin.preconfigure(
      {
        ".release-units/node-core": appStrategy,
        ".release-units/node-app": appStrategy,
      },
      {},
      {},
    );
    const candidates: CandidateReleasePullRequest[] = [
      {
        path: ".release-units/node-core",
        pullRequest: pullRequest("node-core", Version.parse("1.1.0")),
        config: REPOSITORY_CONFIG[".release-units/node-core"]!,
      },
    ];

    const result = await plugin.run(candidates);
    assert.equal(result.length, 1);
    const releases = result[0]!.pullRequest.body.releaseData;
    assert.deepEqual(
      releases
        .map((release) => ({
          component: release.component,
          version: release.version.toString(),
        }))
        .sort((a, b) => a.component.localeCompare(b.component)),
      [
        { component: "node-app", version: "2.0.1" },
        { component: "node-core", version: "1.1.0" },
      ],
    );
    assert.equal(
      result[0]!.pullRequest.updates.some(
        (update) => update.path === ".release-please-manifest.json",
      ),
      true,
    );
  });

  it("does not patch a dependent when the dependency remains in range", async () => {
    const compatibleGraph: ReleaseUnitGraph = {
      ...GRAPH,
      edges: [
        {
          from: "node-app",
          to: "node-core",
          kind: "runtime",
          requirement: "workspace:^",
          propagation: "outside-range",
          publishOrder: true,
        },
      ],
    };
    const plugin = new ReleaseUnitWorkspacePlugin({} as Scm, "main", REPOSITORY_CONFIG, {
      graph: compatibleGraph,
    });
    await plugin.preconfigure({} as Record<string, Strategy>, {}, {});
    const result = await plugin.run([
      {
        path: ".release-units/node-core",
        pullRequest: pullRequest("node-core", Version.parse("1.1.0")),
        config: REPOSITORY_CONFIG[".release-units/node-core"]!,
      },
    ]);
    assert.deepEqual(
      result[0]?.pullRequest.body.releaseData.map((release) => release.component),
      ["node-core"],
    );
  });
});
