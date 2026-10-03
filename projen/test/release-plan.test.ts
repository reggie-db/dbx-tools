import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReleaseUnitGraph } from "../src/release-catalog.ts";
import { buildRecoveryReleasePlan, buildReleasePlan } from "../src/release-plan.ts";

function graph(coreVersion: string, appVersion: string, appHash = "b"): ReleaseUnitGraph {
  return {
    schemaVersion: 1,
    mode: "independent",
    units: [
      {
        id: "node-app",
        component: "node-app",
        version: appVersion,
        projects: ["packages/app"],
        artifacts: [],
        sourceHash: appHash.repeat(64),
      },
      {
        id: "node-core",
        component: "node-core",
        version: coreVersion,
        projects: ["packages/core"],
        artifacts: [],
        sourceHash: "a".repeat(64),
      },
    ],
    projects: [
      {
        id: "packages/app",
        identity: "@example/app",
        language: "javascript",
        path: "packages/app",
        unit: "node-app",
        publish: true,
        sourceHash: appHash.repeat(64),
      },
      {
        id: "packages/core",
        identity: "@example/core",
        language: "javascript",
        path: "packages/core",
        unit: "node-core",
        publish: true,
        sourceHash: "a".repeat(64),
      },
    ],
    artifacts: [],
    edges: [
      {
        from: "node-app",
        to: "node-core",
        kind: "runtime",
        propagation: "outside-range",
        publishOrder: true,
      },
    ],
    publishBatches: [["node-core"], ["node-app"]],
  };
}

describe("release plan", () => {
  it("selects changed units and omits unaffected language stages", () => {
    const plan = buildReleasePlan(graph("1.0.0", "2.0.1"), graph("1.0.0", "2.0.0", "c"));

    assert.deepEqual(plan.units, [
      {
        id: "node-app",
        component: "node-app",
        oldVersion: "2.0.0",
        newVersion: "2.0.1",
        tag: "node-app-v2.0.1",
        reason: "direct",
        sourceHash: "b".repeat(64),
      },
    ]);
    assert.deepEqual(plan.nodePackages, [
      {
        unit: "node-app",
        identity: "@example/app",
        path: "packages/app",
        version: "2.0.1",
      },
    ]);
    assert.deepEqual(plan.publishBatches, [["node-app"]]);
    assert.deepEqual(plan.stages, {
      rust: false,
      python: false,
      node: true,
      github: false,
      docs: true,
    });
    assert.deepEqual(plan.omittedStages, ["rust", "python", "github"]);
  });

  it("classifies version-only dependent releases as propagated", () => {
    const plan = buildReleasePlan(graph("1.1.0", "2.0.1"), graph("1.0.0", "2.0.0"));
    assert.deepEqual(
      plan.units.map(({ id, reason }) => ({ id, reason })),
      [
        { id: "node-app", reason: "propagated" },
        { id: "node-core", reason: "propagated" },
      ],
    );
  });

  it("reconstructs one component without releasing unrelated units", () => {
    const current = graph("1.1.0", "2.0.1");
    const plan = buildRecoveryReleasePlan(current, "node-core", "1.1.0");
    assert.deepEqual(
      plan.units.map((unit) => unit.id),
      ["node-core"],
    );
    assert.deepEqual(
      plan.nodePackages.map((pkg) => pkg.identity),
      ["@example/core"],
    );
    assert.throws(() => buildRecoveryReleasePlan(current, "node-core", "9.9.9"), /does not match/);
  });

  it("combines UniFFI and binary inputs into one target plan", () => {
    const target = {
      os: "linux",
      cpu: "x64",
      node: "linux-x64-gnu",
      cargo: "x86_64-unknown-linux-gnu",
      runner: "ubuntu-22.04",
      python: "manylinux_2_35_x86_64",
      libc: "glibc",
    };
    const releaseGraph: ReleaseUnitGraph = {
      schemaVersion: 1,
      mode: "independent",
      units: [
        {
          id: "rust-core",
          component: "rust-core",
          version: "1.0.0",
          projects: ["native/core"],
          artifacts: ["rust-core:npm"],
          sourceHash: "a".repeat(64),
        },
        {
          id: "rust-tool",
          component: "rust-tool",
          version: "1.0.0",
          projects: ["native/tool"],
          artifacts: ["rust-tool:binary"],
          sourceHash: "b".repeat(64),
        },
      ],
      projects: [
        {
          id: "native/core",
          identity: "fixture-core",
          language: "rust",
          path: "native/core",
          unit: "rust-core",
          publish: true,
          sourceHash: "a".repeat(64),
        },
        {
          id: "native/tool",
          identity: "fixture-tool",
          language: "rust",
          path: "native/tool",
          unit: "rust-tool",
          publish: true,
          sourceHash: "b".repeat(64),
        },
      ],
      artifacts: [
        {
          id: "rust-core:npm",
          unit: "rust-core",
          kind: "npm",
          name: "@fixture/core-native",
          publish: true,
          generated: true,
          data: { targets: [target] },
        },
        {
          id: "rust-tool:binary",
          unit: "rust-tool",
          kind: "github-binary",
          name: "fixture-tool",
          publish: true,
          generated: true,
          data: {
            crate: "fixture-tool",
            binary: "fixture-tool-tray",
            features: ["tray"],
            targets: [target],
          },
        },
      ],
      edges: [],
      publishBatches: [["rust-core", "rust-tool"]],
    };
    const previous: ReleaseUnitGraph = {
      ...releaseGraph,
      units: releaseGraph.units.map((unit) => ({ ...unit, version: "0.9.0" })),
    };

    const plan = buildReleasePlan(releaseGraph, previous);
    assert.deepEqual(plan.rustTargets[0], {
      ...target,
      glibcVersion: "",
      packages: ["fixture-core", "fixture-tool"],
      binaries: ["fixture-tool-tray"],
      features: ["fixture-core/uniffi-bindgen", "fixture-tool/tray"],
    });
  });
});
