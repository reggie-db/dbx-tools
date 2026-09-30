import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ReleaseUnitGraph } from "../src/release-catalog.ts";
import { bootstrapReleaseUnits } from "../tasks/release-bootstrap.ts";

const GRAPH: ReleaseUnitGraph = {
  schemaVersion: 1,
  mode: "fixed",
  units: [
    {
      id: "node-app",
      component: "node-app",
      version: "1.2.3",
      projects: ["packages/app"],
      artifacts: [],
      sourceHash: "a".repeat(64),
    },
  ],
  projects: [],
  artifacts: [],
  edges: [],
  publishBatches: [["node-app"]],
};

describe("release unit bootstrap", () => {
  it("creates writable Release Please state once and validates reruns", () => {
    const root = mkdtempSync(join(tmpdir(), "release-bootstrap-"));
    try {
      const graphDirectory = join(root, ".projen");
      mkdirSync(graphDirectory, { recursive: true });
      writeFileSync(
        join(graphDirectory, "release-units.json"),
        `${JSON.stringify(GRAPH, null, 2)}\n`,
      );

      bootstrapReleaseUnits(root);
      bootstrapReleaseUnits(root);

      const manifest = JSON.parse(
        readFileSync(join(root, ".release-please-manifest.json"), "utf8"),
      ) as Record<string, string>;
      assert.equal(manifest[".release-units/node-app"], "1.2.3");
      assert.equal(
        readFileSync(join(root, ".release-units/node-app/version.txt"), "utf8"),
        "1.2.3\n",
      );
      assert.equal(
        readFileSync(join(root, ".release-units/node-app/CHANGELOG.md"), "utf8"),
        "# Changelog\n",
      );
      assert.equal(existsSync(join(root, ".release-units/node-app/source.json")), false);

      writeFileSync(
        join(root, ".release-please-manifest.json"),
        `${JSON.stringify({ ".release-units/node-app": "9.9.9" })}\n`,
      );
      assert.throws(() => bootstrapReleaseUnits(root), /already contains/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
