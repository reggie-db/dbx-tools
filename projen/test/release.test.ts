import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    releaseSetupSteps: [
      {
        name: "Setup Python",
        uses: "actions/setup-python@v6",
        with: { "python-version": "3.11" },
      },
      {
        name: "Install CLI documentation parser",
        run: "python -m pip install -r docs/requirements.txt",
      },
    ],
    releaseDocs: {
      siteUrl: "https://docs.example.com",
      base: "/fixture/",
      prepareSteps: [
        { name: "Validate public source documentation", run: "bun tools/check-docs.ts" },
        { name: "Generate docs from READMEs", run: "bun tools/sync-docs.ts" },
      ],
      buildSteps: [
        { name: "Generate API docs", run: "bun tools/api-docs.ts" },
        { name: "Check generated titles", run: "bun tools/check-titles.ts" },
      ],
      artifactPath: "custom-site/dist",
    },
    releasePythonRoot: "python/packages",
    releaseValidationTasks: ["docs:check-source", "docs:check-readmes"],
  });
  project.synth();
  release = readWorkflow(outdir, "release");
});

after(() => {
  delete process.env.PROJEN_DISABLE_POST;
  rmSync(outdir, { recursive: true, force: true });
});

describe("unified release workflow", () => {
  it("builds and publishes directly from annotated main tags", () => {
    assert.equal(release.name, "release");
    assert.equal(release["run-name"], "release ${{ github.ref_name }}");
    assert.deepEqual(workflowTrigger<{ tags: string[] }>(release, "push"), { tags: ["v*"] });
    assert.equal("release" in release.on, false);
    assert.equal("workflow_dispatch" in release.on, false);
    assert.deepEqual(release.concurrency, {
      group: "release-${{ github.ref_name }}",
      "cancel-in-progress": false,
    });
    assert.deepEqual(release.permissions, { contents: "read" });

    const verifyJob = release.jobs["build-release"]!;
    assert.deepEqual(verifyJob.permissions, { contents: "read" });
    assert.equal(step(verifyJob, "Checkout release source").with?.["fetch-depth"], 0);
    assert.equal(step(verifyJob, "Install dependencies").run, "bun install");
    const verify = step(verifyJob, "Verify release context");
    assert.equal(verify.env?.RELEASE_TAG, "${{ github.ref_name }}");
    assert.ok(verify.run?.includes("tasks/release-version.ts"));
    assert.match(step(verifyJob, "Verify generated sources").run ?? "", /bunx projen/);
    assert.match(step(verifyJob, "Verify generated sources").run ?? "", /git diff/);
    assert.equal(step(verifyJob, "Verify workspace versions").run, "bun run version:check");
    assert.match(step(verifyJob, "Setup bun").uses ?? "", /^oven-sh\/setup-bun@/);
    assert.deepEqual(step(verifyJob, "Setup bun").with, { "bun-version": "1.3.14" });
    const names = verifyJob.steps.map((candidate) => candidate.name);
    assert.ok(
      names.indexOf("Install CLI documentation parser") <
        names.indexOf("Validate docs:check-readmes"),
    );
    assert.ok(step(verifyJob, "Build npm archives").run?.includes("--output .release/npm"));
    assert.ok(step(verifyJob, "Build npm archives").run?.includes("bun run compile"));
    assert.ok(step(verifyJob, "Build npm archives").run?.includes("--skip-compile"));
    assert.ok(
      step(verifyJob, "Build npm archives").run?.includes("--outfile=.release/npm/publish-npm.mjs"),
    );
    assert.equal(step(verifyJob, "Upload npm archives").with?.name, "release-npm");
    assert.equal(
      verifyJob.steps.some((candidate) => candidate.name === "Setup uv"),
      false,
    );
    assert.ok(verify.run?.includes('test "$(git cat-file -t "$RELEASE_TAG")" = "tag"'));
    assert.ok(verify.run?.includes('test "$(git rev-parse HEAD)" = "$RELEASE_SHA"'));
    assert.ok(verify.run?.includes('test "$(git rev-parse "origin/main")" = "$RELEASE_SHA"'));
    assert.equal(
      verifyJob.steps.some((candidate) => candidate.name === "Build and upload release artifacts"),
      false,
    );
  });

  it("publishes npm through the shared authenticated driver", () => {
    const job = release.jobs["publish-node"]!;
    assert.ok(job.if?.includes("outputs.npm == 'true'"));
    assert.deepEqual(job.permissions, { contents: "read", "id-token": "write" });
    assert.equal(job.env?.BUN_VERSION, undefined);
    assert.deepEqual(step(job, "Setup Bun").with, { "bun-version": "1.3.14" });
    assert.deepEqual(step(job, "Setup Node.js").with, {
      "node-version": "24",
      "registry-url": "https://registry.npmjs.org",
      "package-manager-cache": false,
    });
    assert.equal(step(job, "Install npm CLI").run, "npm install --global npm@11.4.2");
    assert.equal(job.needs, "build-release");
    for (const name of ["Install dependencies", "Checkout release commit"]) {
      assert.equal(
        job.steps.some((candidate) => candidate.name === name),
        false,
      );
    }
    assert.deepEqual(step(job, "Download npm archives").with, {
      name: "release-npm",
      path: ".release/npm",
    });
    assert.equal(
      job.steps.some((candidate) => candidate.name === "Checkout npm recovery automation"),
      false,
    );

    assert.equal(
      job.steps.some((candidate) => candidate.name === "Download approved npm archives"),
      false,
    );
    const publish = step(job, "Publish npm workspace");
    assert.equal(publish.env?.NODE_AUTH_TOKEN, "${{ secrets.NPM_TOKEN }}");
    assert.equal(publish.env?.NPM_CONFIG_PROVENANCE, "true");
    assert.equal(publish.env?.ACCEPT_STAGED, undefined);
    assert.equal(publish.env?.NPM_BOOTSTRAP, undefined);
    assert.equal(publish.env?.DRY_RUN, undefined);
    assert.ok(publish.run?.includes(".release/npm/publish-npm.mjs --directory .release/npm"));
    assert.equal(
      publish.env?.RELEASE_VERSION,
      "${{ needs.build-release.outputs.release_version }}",
    );
    assert.doesNotMatch(publish.run ?? "", /release-automation|ACCEPT_STAGED/);
  });

  it("builds and selectively deploys docs in the same workflow", () => {
    const build = release.jobs["build-release"]!;
    assert.equal(build.if, undefined);
    assert.equal(build.needs, undefined);
    assert.deepEqual(build.permissions, { contents: "read" });
    assert.equal(build.env?.DOCS_SITE_URL, "https://docs.example.com");
    assert.equal(build.env?.DOCS_BASE, "/fixture/");
    const stepNames = build.steps.map((candidate) => candidate.name);
    assert.equal(step(build, "Setup Python").uses, "actions/setup-python@v6");
    assert.ok(
      stepNames.indexOf("Validate public source documentation") <
        stepNames.indexOf("Generate docs from READMEs"),
    );
    assert.ok(stepNames.indexOf("Generate API docs") < stepNames.indexOf("Check generated titles"));
    assert.equal(step(build, "Upload Pages artifact").uses, "actions/upload-pages-artifact@v4");
    assert.deepEqual(step(build, "Upload Pages artifact").with, {
      path: "custom-site/dist",
    });

    const deploy = release.jobs["deploy-docs"]!;
    assert.deepEqual(deploy.needs, ["build-release", "publish-node"]);
    assert.equal(release.jobs["build-docs"], undefined);
    assert.ok(deploy.if?.includes("outputs.docs == 'true'"));
    assert.ok(deploy.if?.includes("needs['publish-node'].result == 'skipped'"));
    assert.deepEqual(deploy.environment, {
      name: "github-pages",
      url: "${{ steps.deployment.outputs.page_url }}",
    });
    assert.deepEqual(deploy.permissions, { pages: "write", "id-token": "write" });
    assert.equal(step(deploy, "Deploy to GitHub Pages").uses, "actions/deploy-pages@v4");

    assert.equal(release.jobs["publish-github-release"], undefined);
  });

  it("contains no cross-workflow handoff", () => {
    assert.equal("repository_dispatch" in release.on, false);
    assert.equal("workflow_run" in release.on, false);
    for (const file of ["node-release.yml", "python-release.yml", "docs.yml"]) {
      assert.equal(existsSync(join(outdir, ".github", "workflows", file)), false);
    }
  });
});

describe("release task contracts", () => {
  it("exposes pure bump, version check, and direct tag release tasks", () => {
    const tasks = JSON.parse(readFileSync(join(outdir, ".projen/tasks.json"), "utf8")) as {
      tasks: Record<string, { steps?: Array<{ execArgs?: string[] }> }>;
    };
    assert.deepEqual(tasks.tasks.bump?.steps?.[0]?.execArgs, [
      "bun",
      "node_modules/@dbx-tools/projen/tasks/bump.ts",
    ]);
    assert.deepEqual(tasks.tasks["version:check"]?.steps?.[0]?.execArgs, [
      "bun",
      "node_modules/@dbx-tools/projen/tasks/version-check.ts",
    ]);
    assert.deepEqual(tasks.tasks.release?.steps?.[0]?.execArgs?.slice(0, 6), [
      "bun",
      "node_modules/@dbx-tools/projen/tasks/release.ts",
      "--prefix",
      "v",
      "--branch",
      "main",
    ]);
  });

  it("compiles before projecting publish configuration into archives", () => {
    const driver = readFileSync(join(import.meta.dirname, "..", "tasks", "publish.ts"), "utf8");
    assert.ok(
      driver.indexOf("compiling ${compiled.length}") <
        driver.indexOf("packNpmPackage(dir, packed, path, applyPublishConfig)"),
    );
    assert.doesNotMatch(driver, /applyPublishConfig\(manifestPath\)/);
    assert.match(driver, /import \{ delimiter,/);
    assert.doesNotMatch(driver, /split\(":"\)/);
    assert.match(driver, /"npm",\s*\["publish",[\s\S]*archive\]/);
    assert.doesNotMatch(driver, /runAsync\(dir, "bun", \["publish", \.\.\.publishArgs\]/);
    assert.match(driver, /\["--access", access\]/);
    assert.doesNotMatch(driver, /restoreManifestMode|chmodSync|lstatSync/);
  });

  it("publishes reviewed versions without repairing manifests", () => {
    const driver = readFileSync(join(import.meta.dirname, "..", "tasks", "publish.ts"), "utf8");
    assert.doesNotMatch(driver, /--stamp-only|pm", "pkg", "set/);
    assert.ok(driver.includes("workspace manifests do not match release ${version}; run projen"));
    assert.doesNotMatch(driver, /bun\.lock|lockfileMatchesManifestVersions/);
  });
});

describe("optional Node release stage", () => {
  it("rejects publication configuration when release mode is disabled", () => {
    const disabledOutdir = mkdtempSync(join(tmpdir(), "release-conflict-"));
    try {
      assert.throws(
        () =>
          new DBXToolsNodeProject({
            name: "release-conflict",
            outdir: disabledOutdir,
            releaseMode: "disabled",
            nodeRelease: false,
          }),
        /cannot be combined/,
      );
    } finally {
      rmSync(disabledOutdir, { recursive: true, force: true });
    }
  });

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
      assert.ok(workflow.jobs["build-release"]);
      assert.equal(workflow.jobs["publish-node"], undefined);
      assert.equal(workflow.jobs["build-docs"], undefined);
    } finally {
      rmSync(disabledOutdir, { recursive: true, force: true });
    }
  });

  it("omits repository title policy when disabled", () => {
    const disabledOutdir = mkdtempSync(join(tmpdir(), "title-policy-disabled-"));
    try {
      const project = new DBXToolsNodeProject({
        name: "disabled-title-policy",
        outdir: disabledOutdir,
        github: true,
        buildWorkflow: true,
        githubOptions: { pullRequestLint: false },
      });
      project.synth();
      assert.equal(
        existsSync(join(disabledOutdir, ".github/workflows/pull-request-lint.yml")),
        false,
      );
    } finally {
      rmSync(disabledOutdir, { recursive: true, force: true });
    }
  });

  it("can disable the unified release surface entirely", () => {
    const disabledOutdir = mkdtempSync(join(tmpdir(), "release-mode-disabled-"));
    try {
      const project = new DBXToolsNodeProject({
        name: "disabled-release-surface",
        outdir: disabledOutdir,
        github: true,
        releaseMode: "disabled",
      });
      project.synth();
      const tasks = JSON.parse(
        readFileSync(join(disabledOutdir, ".projen/tasks.json"), "utf8"),
      ) as {
        tasks: Record<string, unknown>;
      };

      assert.equal(tasks.tasks.release, undefined);
      assert.equal(tasks.tasks.bump, undefined);
      assert.equal(tasks.tasks["version:check"], undefined);
      assert.equal(existsSync(join(disabledOutdir, ".github/workflows/release.yml")), false);
    } finally {
      rmSync(disabledOutdir, { recursive: true, force: true });
    }
  });

  it("generates one fixed-version promotion workflow for Node-only roots", () => {
    const fixedOutdir = mkdtempSync(join(tmpdir(), "release-fixed-node-"));
    try {
      writeFileSync(join(fixedOutdir, "VERSION"), "1.2.3\n");
      const project = new DBXToolsNodeProject({
        name: "fixed-release-fixture",
        outdir: fixedOutdir,
        github: true,
        buildWorkflow: true,
        defaultTagMixins: false,
        releaseDocs: {
          siteUrl: "https://docs.example.com",
          base: "/",
          prepareSteps: [],
          buildSteps: [],
          artifactPath: "site/dist",
        },
      });
      project.synth();

      const workflow = readWorkflow(fixedOutdir);
      assert.ok(workflow.jobs["build-release"]);
      assert.equal(workflow.jobs["publish-node"]?.needs, "build-release");
      assert.equal(workflow.jobs["build-docs"], undefined);
      assert.equal(workflow.jobs["build-release"]?.env?.DOCS_SITE_URL, "https://docs.example.com");
      assert.equal(workflow.jobs["build-release"]?.env?.DOCS_BASE, "/");
      assert.deepEqual(workflow.jobs["deploy-docs"]?.needs, ["build-release", "publish-node"]);
      assert.equal("release-please" in workflow.jobs, false);
      assert.equal("release-plan" in workflow.jobs, false);
      assert.equal("publish-github-release" in workflow.jobs, false);
      const tasks = JSON.parse(readFileSync(join(fixedOutdir, ".projen/tasks.json"), "utf8")) as {
        tasks: Record<string, { steps?: Array<{ execArgs?: string[] }> }>;
      };
      assert.equal(
        tasks.tasks.release?.steps?.[0]?.execArgs?.[1],
        "node_modules/@dbx-tools/projen/tasks/release.ts",
      );
      const build = readWorkflow(fixedOutdir, "build");
      assert.ok(workflowTrigger(build, "pull_request"));
    } finally {
      rmSync(fixedOutdir, { recursive: true, force: true });
    }
  });
});
