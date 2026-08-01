/**
 * Release workflow authentication.
 *
 * `NODE_AUTH_TOKEN` alone does not authenticate npm. `actions/setup-node`
 * writes the temporary registry-scoped npmrc only when `registry-url` is set;
 * dropping that field leaves the secret present but every publish fails with
 * ENEEDAUTH. Both package and standalone release workflows share this setup.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DBXToolsNodeProject } from "../src/project.ts";

let outdir: string;

before(() => {
  process.env.PROJEN_DISABLE_POST = "1";
  outdir = mkdtempSync(join(tmpdir(), "release-"));
  const project = new DBXToolsNodeProject({
    name: "release-fixture",
    outdir,
    github: true,
    standaloneReleases: [{ name: "engine-release", directory: "engine", tagPrefix: "engine-v" }],
  });
  project.synth();
});

after(() => {
  delete process.env.PROJEN_DISABLE_POST;
  rmSync(outdir, { recursive: true, force: true });
});

describe("npm release workflow auth", () => {
  for (const name of ["release", "engine-release"]) {
    it(`${name} configures npmjs before publishing`, () => {
      const workflow = readFileSync(join(outdir, ".github", "workflows", `${name}.yml`), "utf8");
      assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
      assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    });
  }
});

describe("generated engine task paths", () => {
  it("uses the stable package symlink rather than pnpm's physical store path", () => {
    const tasks = JSON.parse(readFileSync(join(outdir, ".projen", "tasks.json"), "utf8")) as {
      tasks: Record<string, { steps: Array<{ exec?: string }> }>;
    };

    assert.equal(
      tasks.tasks.sync?.steps[0]?.exec,
      "tsx node_modules/@dbx-tools/projen/tasks/sync.ts",
    );
  });
});
