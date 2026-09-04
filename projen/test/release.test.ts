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
    releaseWorkflowName: "node-release",
    releaseUpstreamWorkflow: "python-release",
    standaloneReleases: [{ name: "engine-release", directory: "engine", tagPrefix: "engine-v" }],
  });
  project.synth();
});

after(() => {
  delete process.env.PROJEN_DISABLE_POST;
  rmSync(outdir, { recursive: true, force: true });
});

describe("npm release workflow auth", () => {
  for (const name of ["node-release", "engine-release"]) {
    it(`${name} configures npmjs before publishing`, () => {
      const workflow = readFileSync(join(outdir, ".github", "workflows", `${name}.yml`), "utf8");
      assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
      assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    });
  }
});

describe("npm release workflow performance", () => {
  it("delegates workspace compilation and concurrent publishing to the shared driver", () => {
    const workflow = readFileSync(join(outdir, ".github", "workflows", "node-release.yml"), "utf8");
    assert.match(workflow, /tasks\/publish\.ts "\$VERSION"/);
    assert.match(workflow, /workflows:\s+- python-release/);
    assert.match(workflow, /github\.event\.workflow_run\.head_sha/);

    const driver = readFileSync(join(import.meta.dirname, "..", "tasks", "publish.ts"), "utf8");
    assert.match(driver, /"--ignore-scripts"/);
    assert.match(driver, /compiled\.flatMap\(\(pkg\) => \["--filter", pkg\.name\]\)/);
    assert.match(driver, /runConcurrent\(publishable, concurrency/);
    assert.match(driver, /lockfileMatchesVersion/);
  });
});

describe("generated engine task paths", () => {
  it("uses the stable package symlink rather than pnpm's physical store path", () => {
    const tasks = JSON.parse(readFileSync(join(outdir, ".projen", "tasks.json"), "utf8")) as {
      tasks: Record<string, { steps: Array<{ exec?: string }> }>;
    };

    assert.equal(
      tasks.tasks.sync?.steps[0]?.exec,
      "bun node_modules/@dbx-tools/projen/tasks/sync.ts",
    );
  });
});

describe("optional Node release stages", () => {
  it("publishes directly from tags when no upstream stage exists", () => {
    const directOutdir = mkdtempSync(join(tmpdir(), "release-direct-"));
    try {
      const project = new DBXToolsNodeProject({
        name: "direct-release-fixture",
        outdir: directOutdir,
        github: true,
        releaseWorkflowName: "node-release",
      });
      project.synth();
      const workflow = readFileSync(
        join(directOutdir, ".github", "workflows", "node-release.yml"),
        "utf8",
      );
      assert.match(workflow, /^  push:\n    tags:\n      - v\*$/m);
      assert.doesNotMatch(workflow, /workflow_run:/);
    } finally {
      rmSync(directOutdir, { recursive: true, force: true });
    }
  });

  it("omits the Node release workflow when disabled", () => {
    const disabledOutdir = mkdtempSync(join(tmpdir(), "release-disabled-"));
    try {
      const project = new DBXToolsNodeProject({
        name: "disabled-release-fixture",
        outdir: disabledOutdir,
        github: true,
        releaseWorkflowName: false,
      });
      project.synth();
      assert.equal(
        readFileSync(join(disabledOutdir, ".projen", "files.json"), "utf8").includes(
          ".github/workflows/node-release.yml",
        ),
        false,
      );
    } finally {
      rmSync(disabledOutdir, { recursive: true, force: true });
    }
  });
});
