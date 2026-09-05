import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DBXToolsNodeProject } from "../src/project.ts";

let outdir: string;
let release: string;

before(() => {
  process.env.PROJEN_DISABLE_POST = "1";
  outdir = mkdtempSync(join(tmpdir(), "release-"));
  const workflows = join(outdir, ".github", "workflows");
  const project = new DBXToolsNodeProject({
    name: "release-fixture",
    outdir,
    github: true,
    buildWorkflow: true,
    releaseDocs: {
      siteUrl: "https://docs.example.com",
      base: "/fixture/",
    },
  });
  project.synth();
  release = readFileSync(join(workflows, "release.yml"), "utf8");
});

after(() => {
  delete process.env.PROJEN_DISABLE_POST;
  rmSync(outdir, { recursive: true, force: true });
});

describe("unified release workflow", () => {
  it("triggers directly from annotated tags and safe manual dry runs", () => {
    assert.match(release, /^name: release$/m);
    assert.match(release, /^  push:\n    tags:\n      - v\*$/m);
    assert.match(release, /^  workflow_dispatch:$/m);
    assert.match(release, /dry_run:[\s\S]*?default: true[\s\S]*?required: true/);
    assert.match(release, /test "\$DRY_RUN" = "true"/);
    assert.match(release, /git cat-file -t "\$RELEASE_TAG"/);
    assert.match(release, /git rev-parse "\$RELEASE_TAG\^\{commit\}"/);
    assert.match(release, /test "\$\(git rev-parse HEAD\)" = "\$RELEASE_SHA"/);
    assert.match(release, /^  group: release$/m);
    assert.match(release, /^  cancel-in-progress: true$/m);
  });

  it("publishes npm with npmjs authentication and push-only provenance", () => {
    assert.match(release, /^  publish-node:$/m);
    assert.match(release, /registry-url: https:\/\/registry\.npmjs\.org/);
    assert.match(release, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    assert.match(
      release,
      /NPM_CONFIG_PROVENANCE: \$\{\{ github\.event_name == 'push' && 'true' \|\| 'false' \}\}/,
    );
    assert.match(
      release,
      /DRY_RUN: \$\{\{ github\.event_name == 'workflow_dispatch' && '--dry-run' \|\| '' \}\}/,
    );
    assert.match(release, /tasks\/publish\.ts "\$RELEASE_VERSION" \$DRY_RUN/);
    assert.match(release, /^      BUN_VERSION: 1\.3\.14$/m);
    assert.match(release, /uses: actions\/cache\/restore@v5/);
    assert.match(release, /uses: actions\/cache\/save@v5/);
  });

  it("builds and deploys docs in the same release workflow", () => {
    assert.match(release, /^  build-docs:$/m);
    assert.match(release, /^  deploy-docs:$/m);
    assert.match(release, /DOCS_SITE_URL: https:\/\/docs\.example\.com/);
    assert.match(release, /DOCS_BASE: \/fixture\//);
    assert.match(release, /bun docs\/scripts\/sync-readmes\.mjs/);
    assert.match(release, /bun docs\/scripts\/generate-api-docs\.mjs/);
    assert.match(release, /uses: actions\/upload-pages-artifact@v4/);
    assert.match(release, /uses: actions\/deploy-pages@v4/);
    const deploy = release.match(/^  deploy-docs:[\s\S]*$/m)?.[0];
    assert.ok(deploy);
    assert.match(deploy, /if: \$\{\{ github\.event_name == 'push' \}\}/);
    assert.match(deploy, /name: github-pages/);
    assert.match(deploy, /pages: write/);
    assert.match(deploy, /id-token: write/);
  });

  it("contains no cross-workflow handoff machinery", () => {
    assert.doesNotMatch(release, /repository_dispatch|workflow_run|run-id|run_attempt/);
    for (const file of [
      "release-dispatch.yml",
      "rust-release.yml",
      "node-release.yml",
      "python-release.yml",
      "docs.yml",
    ]) {
      assert.equal(existsSync(join(outdir, ".github", "workflows", file)), false);
    }
  });
});

describe("npm release workflow performance", () => {
  it("delegates workspace compilation and concurrent publishing to the shared driver", () => {
    const driver = readFileSync(join(import.meta.dirname, "..", "tasks", "publish.ts"), "utf8");
    assert.match(driver, /"--ignore-scripts"/);
    assert.match(driver, /compiled\.flatMap\(\(pkg\) => \["--filter", pkg\.name\]\)/);
    assert.match(driver, /command === "bun" && process\.versions\.bun \? process\.execPath/);
    assert.match(driver, /runConcurrent\(publishable, concurrency/);
    assert.match(driver, /lockfileMatchesVersion/);
    assert.ok(
      driver.indexOf("compiling ${compiled.length}") <
        driver.indexOf("applyPublishConfig(manifestPath)"),
    );
  });
});

describe("release tag push performance", () => {
  it("scans the branch push but bypasses hooks for already-scanned release tags", () => {
    const bump = readFileSync(join(import.meta.dirname, "..", "tasks", "bump.ts"), "utf8");
    assert.match(bump, /git\(\["push", "origin", "HEAD"\]\)/);
    assert.match(bump, /\[publishScript, version, "--stamp-only"\]/);
    assert.match(bump, /assertReleaseTagsPointToHead\(tags\)/);
    assert.match(bump, /git\(\["rev-parse", `\$\{tag\}\^\{commit\}`\], true\)/);
    assert.match(bump, /git\(\["push", "--no-verify", "origin", \.\.\.tags\]\)/);
  });
});

describe("generated engine task paths", () => {
  it("uses the stable package symlink", () => {
    const tasks = JSON.parse(readFileSync(join(outdir, ".projen", "tasks.json"), "utf8")) as {
      tasks: Record<string, { steps: Array<{ exec?: string }> }>;
    };
    assert.equal(
      tasks.tasks.sync?.steps[0]?.exec,
      "bun node_modules/@dbx-tools/projen/tasks/sync.ts",
    );
  });
});

describe("generated workflow safety", () => {
  for (const name of ["build", "pull-request-lint"]) {
    it(`${name} is read-only and cancels superseded runs`, () => {
      const workflow = readFileSync(join(outdir, ".github", "workflows", `${name}.yml`), "utf8");
      assert.match(workflow, /^permissions:\n  contents: read$/m);
      assert.match(
        workflow,
        /^concurrency:\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/m,
      );
      assert.match(workflow, /^  cancel-in-progress: true$/m);
    });
  }

  it("keeps the CI build separate from release", () => {
    const workflow = readFileSync(join(outdir, ".github", "workflows", "build.yml"), "utf8");
    assert.match(workflow, /^name: build$/m);
    assert.match(workflow, /^  pull_request: \{\}$/m);
    assert.doesNotMatch(workflow, /tags:\n\s+- v\*/);
  });

  it("restores and saves Bun's dependency-only package cache", () => {
    const workflow = readFileSync(join(outdir, ".github", "workflows", "build.yml"), "utf8");
    assert.match(workflow, /^      BUN_VERSION: 1\.3\.14$/m);
    assert.match(workflow, /name: Resolve Bun cache/);
    assert.match(workflow, /uses: actions\/cache\/restore@v5/);
    assert.match(workflow, /uses: actions\/cache\/save@v5/);
    assert.match(
      workflow,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    );
    const cacheKey = readFileSync(join(outdir, ".projen", "bun-cache-key.mjs"), "utf8");
    assert.match(cacheKey, /const dependencyFields =/);
    assert.doesNotMatch(cacheKey, /dependencyFields = \[[\s\S]*"version"/);
  });
});

describe("optional Node release stage", () => {
  it("can be omitted while retaining the verified release workflow", () => {
    const disabledOutdir = mkdtempSync(join(tmpdir(), "release-disabled-"));
    try {
      const project = new DBXToolsNodeProject({
        name: "disabled-release-fixture",
        outdir: disabledOutdir,
        github: true,
        nodeRelease: false,
      });
      project.synth();
      const workflow = readFileSync(
        join(disabledOutdir, ".github", "workflows", "release.yml"),
        "utf8",
      );
      assert.match(workflow, /^  verify-context:$/m);
      assert.doesNotMatch(workflow, /^  publish-node:$/m);
    } finally {
      rmSync(disabledOutdir, { recursive: true, force: true });
    }
  });
});
