import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { workspaceGraph } from "../tasks/test-workspace.ts";

it("builds workspace and reverse dependency edges from manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-tests-"));
  const members = ["packages/core", "packages/feature", "packages/app"];
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: members }));
  for (const member of members) mkdirSync(join(root, member), { recursive: true });
  writeFileSync(join(root, members[0]!, "package.json"), JSON.stringify({ name: "@fixture/core" }));
  writeFileSync(
    join(root, members[1]!, "package.json"),
    JSON.stringify({
      name: "@fixture/feature",
      dependencies: { "@fixture/core": "workspace:^" },
    }),
  );
  writeFileSync(
    join(root, members[2]!, "package.json"),
    JSON.stringify({
      name: "@fixture/app",
      devDependencies: { "@fixture/feature": "workspace:^" },
    }),
  );

  assert.deepEqual(workspaceGraph(root), {
    packages: [
      {
        name: "@fixture/app",
        path: "packages/app",
        dependencies: ["@fixture/feature"],
        reverseDependencies: [],
      },
      {
        name: "@fixture/core",
        path: "packages/core",
        dependencies: [],
        reverseDependencies: ["@fixture/feature"],
      },
      {
        name: "@fixture/feature",
        path: "packages/feature",
        dependencies: ["@fixture/core"],
        reverseDependencies: ["@fixture/app"],
      },
    ],
  });
});
