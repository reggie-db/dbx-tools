import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import { workspaceGraph } from "../src/workspace-validation.ts";

const fixtures: string[] = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "workspace-tests-"));
  fixtures.push(root);
  return root;
}

function writeWorkspace(root: string, members: readonly string[]): void {
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    `packages:\n${members.map((member) => `  - ${JSON.stringify(member)}`).join("\n")}\n`,
  );
}

it("builds workspace and reverse dependency edges from manifests", () => {
  const root = fixture();
  const members = ["packages/core", "packages/feature", "packages/app"];
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/ignored"] }));
  writeWorkspace(root, members);
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

it("skips unreadable recorded manifests without changing valid graph edges", () => {
  const root = fixture();
  writeWorkspace(root, ["packages/missing", "packages/malformed", "packages/valid"]);
  mkdirSync(join(root, "packages/malformed"), { recursive: true });
  writeFileSync(join(root, "packages/malformed/package.json"), "{");
  mkdirSync(join(root, "packages/valid"), { recursive: true });
  writeFileSync(
    join(root, "packages/valid/package.json"),
    JSON.stringify({ name: "@fixture/valid" }),
  );

  assert.deepEqual(workspaceGraph(root), {
    packages: [
      {
        name: "@fixture/valid",
        path: "packages/valid",
        dependencies: [],
        reverseDependencies: [],
      },
    ],
  });
});

for (const mode of ["changed"]) {
  it(`runs JavaScript documentation tests in ${mode} mode and skips dependency tests`, () => {
    const root = fixture();
    mkdirSync(join(root, ".projen"));
    mkdirSync(join(root, "test"));
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "docs/scripts/node_modules/dependency"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/ignored"] }));
    writeWorkspace(root, []);
    writeFileSync(
      join(root, "test/root.test.ts"),
      'import { writeFileSync } from "node:fs";\nimport { it } from "node:test";\nit("runs root tests", () => writeFileSync("root-test-ran", "yes"));\n',
    );
    writeFileSync(
      join(root, "scripts/script.test.ts"),
      'import { writeFileSync } from "node:fs";\nimport { it } from "node:test";\nit("runs script tests", () => writeFileSync("script-test-ran", "yes"));\n',
    );
    writeFileSync(
      join(root, "docs/scripts/example.test.mjs"),
      'import { writeFileSync } from "node:fs";\nimport { it } from "node:test";\nit("runs docs", () => writeFileSync("docs-ran", "yes"));\n',
    );
    writeFileSync(
      join(root, "docs/scripts/node_modules/dependency/example.test.ts"),
      'throw new Error("dependency tests must not run");\n',
    );
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
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../tasks/test-workspace.ts", import.meta.url)), mode, "--root", root],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(join(root, "docs-ran"), "utf8"), "yes");
    assert.equal(readFileSync(join(root, "root-test-ran"), "utf8"), "yes");
    assert.equal(readFileSync(join(root, "script-test-ran"), "utf8"), "yes");
  });
}
