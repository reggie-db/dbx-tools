import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, it } from "node:test";

import { withMaterializedWorkspaceManifests } from "../src/workspace-manifest.ts";
import { vendorWorkspaceDependencies } from "../src/workspace-vendor.ts";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture(): { root: string; stage: string } {
  const root = mkdtempSync(join(tmpdir(), "workspace-vendor-source-"));
  const stage = mkdtempSync(join(tmpdir(), "workspace-vendor-stage-"));
  fixtures.push(root, stage);
  for (const member of ["app", "shared", "core"]) {
    mkdirSync(join(root, "packages", member), { recursive: true });
    writeFileSync(join(root, "packages", member, "index.ts"), `export const name = "${member}";\n`);
  }
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        version: "1.2.3",
        workspaces: ["packages/app", "packages/shared", "packages/core"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/app"\n  - "packages/shared"\n  - "packages/core"\n',
  );
  writeFileSync(
    join(root, "packages/app/package.json"),
    `${JSON.stringify({
      name: "@fixture/app",
      version: "1.2.3",
      dependencies: { "@fixture/shared": "workspace:^" },
    })}\n`,
  );
  writeFileSync(
    join(root, "packages/shared/package.json"),
    `${JSON.stringify({
      name: "@fixture/shared",
      version: "1.2.3",
      dependencies: { "@fixture/core": "workspace:^" },
    })}\n`,
  );
  writeFileSync(
    join(root, "packages/core/package.json"),
    `${JSON.stringify({ name: "@fixture/core", version: "1.2.3" })}\n`,
  );
  cpSync(root, stage, { recursive: true });
  return { root, stage };
}

it("vendors the transitive runtime closure when the application uses workspace protocols", async () => {
  const { root, stage } = fixture();
  let packages: readonly string[] = [];
  await withMaterializedWorkspaceManifests(stage, async () => {
    const result = vendorWorkspaceDependencies(root, stage, "packages/app");
    packages = result.packages;
    const manifest = JSON.parse(readFileSync(join(stage, "packages/app/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    assert.match(
      manifest.dependencies["@fixture/shared"]!,
      /^file:\.\/vendor\/npm\/.+-[0-9a-f]{16}\.tgz$/,
    );
    assert.match(
      manifest.dependencies["@fixture/core"]!,
      /^file:\.\/vendor\/npm\/.+-[0-9a-f]{16}\.tgz$/,
    );
    assert.equal(
      readdirSync(join(stage, "packages/app/vendor/npm")).filter((file) => file.endsWith(".tgz"))
        .length,
      2,
    );
    assert.match(
      readFileSync(join(stage, "packages/app/.gitignore"), "utf8"),
      /!\/vendor\/npm\/\*\.tgz/,
    );
    const installed = spawnSync(
      "npm",
      ["install", "--ignore-scripts", "--package-lock=false", "--offline"],
      {
        cwd: join(stage, "packages/app"),
        encoding: "utf8",
      },
    );
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(existsSync(join(stage, "packages/app/node_modules/@fixture/core")), true);
    assert.equal(existsSync(join(stage, "packages/app/node_modules/@fixture/shared")), true);
  });

  assert.deepEqual(packages, ["@fixture/core", "@fixture/shared"]);
  assert.equal(existsSync(join(root, "packages/app/vendor")), false);
  assert.equal(
    JSON.parse(readFileSync(join(root, "packages/app/package.json"), "utf8")).dependencies[
      "@fixture/shared"
    ],
    "workspace:^",
  );
});

it("does not create vendor output without workspace protocol dependencies", async () => {
  const { root, stage } = fixture();
  const sourceManifest = join(root, "packages/app/package.json");
  const stageManifest = join(stage, "packages/app/package.json");
  const manifest = {
    name: "@fixture/app",
    version: "1.2.3",
    dependencies: {},
  };
  writeFileSync(sourceManifest, `${JSON.stringify(manifest)}\n`);
  writeFileSync(stageManifest, `${JSON.stringify(manifest)}\n`);

  await withMaterializedWorkspaceManifests(stage, async () => {
    const result = vendorWorkspaceDependencies(root, stage, "packages/app");
    assert.deepEqual(result, { archives: [], packages: [] });
  });
  assert.equal(existsSync(join(stage, "packages/app/vendor")), false);
});

it("changes the archive identity when unpublished package content changes", async () => {
  const { root, stage } = fixture();
  const first = vendorWorkspaceDependencies(root, stage, "packages/app");
  const firstShared = first.archives.find((archive) => archive.includes("fixture-shared"));
  assert.ok(firstShared);

  writeFileSync(join(root, "packages/shared/index.ts"), 'export const name = "shared-updated";\n');
  const updatedStage = mkdtempSync(join(tmpdir(), "workspace-vendor-stage-updated-"));
  fixtures.push(updatedStage);
  cpSync(root, updatedStage, { recursive: true });
  const second = vendorWorkspaceDependencies(root, updatedStage, "packages/app");
  const secondShared = second.archives.find((archive) => archive.includes("fixture-shared"));
  assert.ok(secondShared);

  assert.notEqual(basename(firstShared), basename(secondShared));
});
