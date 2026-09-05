import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  readWorkflow,
  workflowStep as step,
  workflowTrigger,
  type WorkflowDefinition,
} from "./workflow.ts";
import { DBXToolsNodeProject } from "../src/project.ts";

let outdir: string;
let release: WorkflowDefinition;

before(() => {
  process.env.PROJEN_DISABLE_POST = "1";
  outdir = mkdtempSync(join(tmpdir(), "release-"));
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
  release = readWorkflow(outdir, "release");
});

after(() => {
  delete process.env.PROJEN_DISABLE_POST;
  rmSync(outdir, { recursive: true, force: true });
});

describe("unified release workflow", () => {
  it("uses verified annotated tags and selective manual recovery", () => {
    assert.equal(release.name, "release");
    assert.deepEqual(workflowTrigger<{ tags: string[] }>(release, "push").tags, ["v*"]);
    const inputs = workflowTrigger<{ inputs: Record<string, unknown> }>(
      release,
      "workflow_dispatch",
    ).inputs;
    assert.deepEqual(inputs.dry_run, {
      description: "Build and validate without publishing",
      type: "boolean",
      default: true,
      required: true,
    });
    assert.deepEqual(inputs.stage, {
      description: "Release stage to build, validate, or recover",
      type: "choice",
      options: ["all", "node", "python", "docs"],
      default: "all",
      required: true,
    });
    assert.deepEqual(inputs.source_run_id, {
      description: "Earlier release workflow run containing Rust artifacts",
      type: "string",
      default: "",
      required: false,
    });
    assert.deepEqual(release.concurrency, {
      group: "release",
      "cancel-in-progress": true,
    });
    assert.deepEqual(release.permissions, { contents: "read" });

    const verifyJob = release.jobs["verify-context"]!;
    assert.deepEqual(verifyJob.permissions, { actions: "read", contents: "read" });
    const verify = step(verifyJob, "Verify release context");
    assert.equal(
      verify.env?.DRY_RUN,
      "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run || false }}",
    );
    assert.ok(verify.run?.includes('test "$(git cat-file -t "$RELEASE_TAG")" = "tag"'));
    assert.ok(verify.run?.includes('test "$(git rev-parse HEAD)" = "$RELEASE_SHA"'));
    assert.ok(verify.run?.includes('test "$GITHUB_REF_TYPE" = "tag"'));
    assert.ok(verify.run?.includes('test "$GITHUB_REF_NAME" = "$RELEASE_TAG"'));
    assert.ok(verify.run?.includes("inputs.source_run_id"));
    assert.equal(step(verifyJob, "Verify source artifact run").uses, "actions/github-script@v8");
  });

  it("publishes npm through the shared authenticated driver", () => {
    const job = release.jobs["publish-node"]!;
    assert.equal(
      job.if,
      "${{ github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == 'node' }}",
    );
    assert.deepEqual(job.permissions, { contents: "read", "id-token": "write" });
    assert.equal(job.env?.BUN_VERSION, "1.3.14");
    assert.deepEqual(step(job, "Setup Node.js").with, {
      "node-version": "lts/*",
      "registry-url": "https://registry.npmjs.org",
    });
    assert.equal(step(job, "Restore Bun cache").uses, "actions/cache/restore@v5");
    assert.equal(step(job, "Save Bun cache").uses, "actions/cache/save@v5");

    const publish = step(job, "Compile, package, and publish npm workspace");
    assert.equal(
      publish.env?.NPM_CONFIG_PROVENANCE,
      "${{ (github.event_name == 'push' || inputs.dry_run == false) && 'true' || 'false' }}",
    );
    assert.equal(publish.env?.NODE_AUTH_TOKEN, "${{ secrets.NPM_TOKEN }}");
    assert.equal(
      publish.env?.DRY_RUN,
      "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run && '--dry-run' || '' }}",
    );
    assert.ok(publish.run?.includes("tasks/publish.ts"));
  });

  it("builds and selectively deploys docs in the same workflow", () => {
    const build = release.jobs["build-docs"]!;
    assert.equal(
      build.if,
      "${{ github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == 'docs' }}",
    );
    assert.deepEqual(build.permissions, {
      contents: "read",
      pages: "write",
      "id-token": "write",
    });
    assert.equal(build.env?.DOCS_SITE_URL, "https://docs.example.com");
    assert.equal(build.env?.DOCS_BASE, "/fixture/");
    assert.equal(step(build, "Upload Pages artifact").uses, "actions/upload-pages-artifact@v4");

    const deploy = release.jobs["deploy-docs"]!;
    assert.equal(
      deploy.if,
      "${{ github.event_name == 'push' || (inputs.dry_run == false && (inputs.stage == 'all' || inputs.stage == 'docs')) }}",
    );
    assert.deepEqual(deploy.environment, {
      name: "github-pages",
      url: "${{ steps.deployment.outputs.page_url }}",
    });
    assert.deepEqual(deploy.permissions, { pages: "write", "id-token": "write" });
    assert.equal(step(deploy, "Deploy to GitHub Pages").uses, "actions/deploy-pages@v4");
  });

  it("contains no cross-workflow handoff", () => {
    assert.equal("repository_dispatch" in release.on, false);
    assert.equal("workflow_run" in release.on, false);
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

  it("leaves predecessor workflow removal to the consumer", () => {
    const existingOutdir = mkdtempSync(join(tmpdir(), "release-existing-"));
    const workflowPath = join(existingOutdir, ".github", "workflows", "node-release.yml");
    try {
      mkdirSync(join(existingOutdir, ".github", "workflows"), { recursive: true });
      writeFileSync(workflowPath, "name: consumer-owned\n");
      const project = new DBXToolsNodeProject({
        name: "existing-release-fixture",
        outdir: existingOutdir,
        github: true,
      });
      project.synth();
      assert.equal(readFileSync(workflowPath, "utf8"), "name: consumer-owned\n");
    } finally {
      rmSync(existingOutdir, { recursive: true, force: true });
    }
  });
});

describe("release task contracts", () => {
  it("compiles before applying publish configuration", () => {
    const driver = readFileSync(join(import.meta.dirname, "..", "tasks", "publish.ts"), "utf8");
    assert.ok(
      driver.indexOf("compiling ${compiled.length}") <
        driver.indexOf("applyPublishConfig(manifestPath)"),
    );
  });

  it("stamps members before pushing release tags", () => {
    const bump = readFileSync(join(import.meta.dirname, "..", "tasks", "bump.ts"), "utf8");
    assert.ok(
      bump.indexOf('[publishScript, version, "--stamp-only"]') <
        bump.indexOf('git(["push", "--no-verify", "origin", ...tags])'),
    );
  });
});

describe("generated workflow safety", () => {
  for (const name of ["build", "pull-request-lint"]) {
    it(`${name} is read-only and cancels superseded runs`, () => {
      const workflow = readWorkflow(outdir, name);
      assert.deepEqual(workflow.permissions, { contents: "read" });
      assert.deepEqual(workflow.concurrency, {
        group: "${{ github.workflow }}-${{ github.ref }}",
        "cancel-in-progress": true,
      });
    });
  }

  it("keeps CI separate from release", () => {
    const build = readWorkflow(outdir, "build");
    assert.deepEqual(workflowTrigger(build, "pull_request"), {});
    assert.equal("push" in build.on, false);
  });

  it("uses a dependency-only Bun cache key", () => {
    const cacheKey = readFileSync(join(outdir, ".projen", "bun-cache-key.mjs"), "utf8");
    assert.ok(cacheKey.includes("const dependencyFields ="));
    assert.equal(cacheKey.includes('"version"'), false);
  });
});

describe("optional Node release stage", () => {
  it("can be omitted while retaining context verification", () => {
    const disabledOutdir = mkdtempSync(join(tmpdir(), "release-disabled-"));
    try {
      const project = new DBXToolsNodeProject({
        name: "disabled-release-fixture",
        outdir: disabledOutdir,
        github: true,
        nodeRelease: false,
      });
      project.synth();
      const workflow = readWorkflow(disabledOutdir, "release");
      assert.ok(workflow.jobs["verify-context"]);
      assert.equal(workflow.jobs["publish-node"], undefined);
    } finally {
      rmSync(disabledOutdir, { recursive: true, force: true });
    }
  });
});
