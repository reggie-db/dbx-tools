import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import { workspaceGraph } from "../tasks/test-workspace.ts";

const fixtures: string[] = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "workspace-tests-"));
  fixtures.push(root);
  return root;
}

it("builds workspace and reverse dependency edges from manifests", () => {
  const root = fixture();
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

for (const mode of ["all", "unit", "changed"]) {
  it(`runs JavaScript documentation tests in ${mode} mode and skips dependency tests`, () => {
    const root = fixture();
    mkdirSync(join(root, ".projen"));
    mkdirSync(join(root, "docs/scripts/node_modules/dependency"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
    writeFileSync(
      join(root, "docs/scripts/example.test.mjs"),
      'import { writeFileSync } from "node:fs";\nimport { it } from "node:test";\nit("runs docs", () => writeFileSync("docs-ran", "yes"));\n',
    );
    writeFileSync(
      join(root, "docs/scripts/node_modules/dependency/example.test.ts"),
      'throw new Error("dependency tests must not run");\n',
    );
    if (mode === "changed") {
      const init = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
      assert.equal(init.status, 0, init.stderr);
      const add = spawnSync("git", ["add", "package.json", "docs/scripts/example.test.mjs"], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(add.status, 0, add.stderr);
      const commit = spawnSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.com",
          "commit",
          "--quiet",
          "-m",
          "fixture",
        ],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(commit.status, 0, commit.stderr);
      writeFileSync(join(root, "docs/scripts/helper.mjs"), "export const changed = true;\n");
      const stage = spawnSync("git", ["add", "docs/scripts/helper.mjs"], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(stage.status, 0, stage.stderr);
    }
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../tasks/test-workspace.ts", import.meta.url)), mode, "--root", root],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(join(root, "docs-ran"), "utf8"), "yes");
  });
}
