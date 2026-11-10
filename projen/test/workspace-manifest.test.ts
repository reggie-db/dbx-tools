import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";

import { withMaterializedWorkspaceManifests } from "../src/workspace-manifest.ts";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "workspace-manifest-"));
  fixtures.push(root);
  mkdirSync(join(root, "packages", "pnpm-member"), { recursive: true });
  mkdirSync(join(root, "packages", "package-json-member"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({
      private: true,
      version: "1.2.3",
      workspaces: ["packages/package-json-member"],
    })}\n`,
  );
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/pnpm-member"\n');
  writeFileSync(
    join(root, "packages", "pnpm-member", "package.json"),
    `${JSON.stringify({
      name: "@fixture/pnpm-member",
      dependencies: { dependency: "workspace:^" },
    })}\n`,
  );
  writeFileSync(
    join(root, "packages", "package-json-member", "package.json"),
    `${JSON.stringify({
      name: "@fixture/package-json-member",
      dependencies: { dependency: "workspace:^" },
    })}\n`,
  );
  return root;
}

it("uses pnpm-workspace.yaml as the workspace member source", async () => {
  const root = fixture();

  await withMaterializedWorkspaceManifests(root, async () => {
    const pnpmMember = JSON.parse(
      readFileSync(join(root, "packages", "pnpm-member", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    const packageJsonMember = JSON.parse(
      readFileSync(join(root, "packages", "package-json-member", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.equal(pnpmMember.dependencies.dependency, "^1.2.3");
    assert.equal(packageJsonMember.dependencies.dependency, "workspace:^");
  });
});

it("rejects a missing or malformed root manifest", async () => {
  const missingRoot = mkdtempSync(join(tmpdir(), "workspace-manifest-missing-root-"));
  fixtures.push(missingRoot);
  await assert.rejects(
    withMaterializedWorkspaceManifests(missingRoot, async () => undefined),
    /Could not read workspace manifest/,
  );

  const malformedRoot = fixture();
  writeFileSync(join(malformedRoot, "package.json"), "{");
  await assert.rejects(
    withMaterializedWorkspaceManifests(malformedRoot, async () => undefined),
    /Could not read workspace manifest/,
  );
});

it("rejects missing or malformed recorded package manifests", async () => {
  const missingMember = fixture();
  rmSync(join(missingMember, "packages", "pnpm-member", "package.json"));
  await assert.rejects(withMaterializedWorkspaceManifests(missingMember, async () => undefined));

  const malformedMember = fixture();
  const manifestPath = join(malformedMember, "packages", "pnpm-member", "package.json");
  writeFileSync(manifestPath, "{ malformed\n");
  await assert.rejects(withMaterializedWorkspaceManifests(malformedMember, async () => undefined));
  assert.equal(readFileSync(manifestPath, "utf8"), "{ malformed\n");
});
