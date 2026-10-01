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
      prepareSteps: [
        {
          name: "Setup Python",
          uses: "actions/setup-python@v6",
          with: { "python-version": "3.11" },
        },
        { name: "Setup Rust", uses: "dtolnay/rust-toolchain@stable" },
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
    pullRequestTitlePolicy: {
      types: ["feature", "maintenance"],
      requireScope: true,
    },
    workflowCacheIgnorePaths: ["custom-site"],
  });
  project.synth();
  release = readWorkflow(outdir, "release");
});

after(() => {
  delete process.env.PROJEN_DISABLE_POST;
  rmSync(outdir, { recursive: true, force: true });
});

describe("unified release workflow", () => {
  it("releases the default branch with an annotated tag and supports manual recovery", () => {
    assert.equal(release.name, "release");
    assert.equal(
      release["run-name"],
      "release 0.0.1 ${{ github.event_name == 'push' && github.sha || inputs.release_tag }}",
    );
    assert.deepEqual(workflowTrigger<{ branches: string[]; paths: string[] }>(release, "push"), {
      branches: ["main"],
      paths: ["VERSION"],
    });
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
      "cancel-in-progress": false,
    });
    assert.deepEqual(release.permissions, { contents: "read" });

    const verifyJob = release.jobs["verify-context"]!;
    assert.deepEqual(verifyJob.permissions, { actions: "read", contents: "write" });
    const verify = step(verifyJob, "Verify release context");
    assert.equal(
      verify.env?.DRY_RUN,
      "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run || false }}",
    );
    assert.ok(verify.run?.includes('test "$GITHUB_REF_NAME" = "main"'));
    assert.ok(verify.run?.includes('RELEASE_VERSION="$(tr -d'));
    assert.ok(verify.run?.includes('PREVIOUS_VERSION="$(git show'));
    assert.ok(verify.run?.includes('test "$PREVIOUS_VERSION" != "$RELEASE_VERSION"'));
    assert.ok(verify.run?.includes("tasks/release-version.ts"));
    assert.ok(verify.run?.includes("--assert-next"));
    assert.equal(step(verifyJob, "Setup Bun").uses, "oven-sh/setup-bun@v2");
    assert.ok(verify.run?.includes('git tag -a "$RELEASE_TAG"'));
    assert.ok(verify.run?.includes('git push origin "refs/tags/$RELEASE_TAG"'));
    assert.ok(verify.run?.includes('test "$(git cat-file -t "$RELEASE_TAG")" = "tag"'));
    assert.ok(verify.run?.includes('test "$(git rev-parse HEAD)" = "$RELEASE_SHA"'));
    assert.ok(verify.run?.includes('test "$RELEASE_SHA" = "$EXPECTED_SHA"'));
    assert.doesNotMatch(verify.run ?? "", /GITHUB_REF_TYPE" = "tag"/);
    assert.doesNotMatch(verify.run ?? "", /GITHUB_REF_NAME" = "\$RELEASE_TAG"/);
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
    const stepNames = build.steps.map((candidate) => candidate.name);
    assert.equal(step(build, "Setup Python").uses, "actions/setup-python@v6");
    assert.equal(step(build, "Setup Rust").uses, "dtolnay/rust-toolchain@stable");
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
      "pull-request-lint.yml",
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
  it("exposes pure bump, version check, and reviewed release preparation tasks", () => {
    const tasks = JSON.parse(readFileSync(join(outdir, ".projen/tasks.json"), "utf8")) as {
      tasks: Record<string, { steps?: Array<{ exec?: string }> }>;
    };
    assert.match(tasks.tasks.bump?.steps?.[0]?.exec ?? "", /tasks\/bump\.ts --prefix v/);
    assert.match(tasks.tasks["version:check"]?.steps?.[0]?.exec ?? "", /tasks\/version-check\.ts/);
    assert.match(
      tasks.tasks.release?.steps?.[0]?.exec ?? "",
      /tasks\/release-pr\.ts --prefix v --base main --python-root "python\/packages" --validate-task "docs:check-source" --validate-task "docs:check-readmes"/,
    );
  });

  it("configures summary provider order and opt-out through project options", () => {
    const providersOutdir = mkdtempSync(join(tmpdir(), "release-summary-providers-"));
    const disabledOutdir = mkdtempSync(join(tmpdir(), "release-summary-disabled-"));
    try {
      new DBXToolsNodeProject({
        name: "release-summary-providers",
        outdir: providersOutdir,
        github: true,
        releaseSummary: { providers: ["claude", "codex"] },
      }).synth();
      new DBXToolsNodeProject({
        name: "release-summary-disabled",
        outdir: disabledOutdir,
        github: true,
        releaseSummary: false,
      }).synth();
      const command = (directory: string): string => {
        const tasks = JSON.parse(readFileSync(join(directory, ".projen/tasks.json"), "utf8")) as {
          tasks: Record<string, { steps?: Array<{ exec?: string }> }>;
        };
        return tasks.tasks.release?.steps?.[0]?.exec ?? "";
      };

      assert.match(command(providersOutdir), /--release-summary-providers claude,codex/);
      assert.match(command(disabledOutdir), /--no-release-summary/);
    } finally {
      rmSync(providersOutdir, { recursive: true, force: true });
      rmSync(disabledOutdir, { recursive: true, force: true });
    }
  });

  it("compiles before applying publish configuration", () => {
    const driver = readFileSync(join(import.meta.dirname, "..", "tasks", "publish.ts"), "utf8");
    assert.ok(
      driver.indexOf("compiling ${compiled.length}") <
        driver.indexOf("applyPublishConfig(manifestPath)"),
    );
    assert.match(driver, /import \{ delimiter,/);
    assert.doesNotMatch(driver, /split\(":"\)/);
    assert.match(driver, /\["publish",[\s\S]*archive\]/);
    assert.doesNotMatch(driver, /runAsync\(dir, "bun", \["publish", \.\.\.publishArgs\]/);
    assert.match(driver, /\["--access", access\]/);
  });

  it("keeps bump pure and lets release preparation own git and local publication", () => {
    const bump = readFileSync(join(import.meta.dirname, "..", "tasks", "bump.ts"), "utf8");
    assert.ok(bump.includes("writeWorkspaceVersion(root, next.version)"));
    assert.ok(bump.includes('process.execPath, [".projenrc.ts"]'));
    assert.doesNotMatch(bump, /git\(\[/);
    assert.doesNotMatch(bump, /publishLocalRelease|publish\.ts|gh/);

    const releasePr = readFileSync(
      join(import.meta.dirname, "..", "tasks", "release-pr.ts"),
      "utf8",
    );
    assert.ok(releasePr.includes("await withWorkspaceMutationLock(root, async () =>"));
    assert.ok(
      releasePr.indexOf('git(root, ["commit", "-m", opts.message])') <
        releasePr.indexOf("pushCurrentBranch(root, currentBranch)"),
    );
    assert.ok(
      releasePr.indexOf("pushCurrentBranch(root, currentBranch)") <
        releasePr.indexOf('git(root, ["worktree", "add"'),
    );
    assert.match(releasePr, /\["worktree", "add", "-b", releaseBranch, releaseRoot, "HEAD"\]/);
    assert.doesNotMatch(releasePr, /worktree", "add", "--branch"/);
    assert.ok(releasePr.includes('git(root, ["merge", "--no-edit", `origin/${opts.base}`])'));
    assert.match(releasePr, /"stash",\s*"push",\s*"--include-untracked"/);
    assert.doesNotMatch(releasePr, /git\(root, \["switch"/);
    assert.ok(
      releasePr.indexOf("if (opts.approve)") < releasePr.indexOf('git(root, ["worktree", "remove"'),
    );
    assert.match(releasePr, /"test",\s*"--workspace"/);
    assert.doesNotMatch(releasePr, /cargo",\s*\["metadata"/);
    assert.doesNotMatch(releasePr, /\["run", "rs:bindings"\]/);
    assert.doesNotMatch(releasePr, /process\.execPath, \["run", "test"\]/);
    assert.match(releasePr, /\["push", "--no-verify", "--set-upstream", "origin", releaseBranch\]/);
    assert.ok(
      releasePr.indexOf("await publishLocalRelease") <
        releasePr.indexOf('git(releaseRoot, ["commit", "-m", `chore(release): ${next.version}`])'),
    );
    const localCargo = readFileSync(
      join(import.meta.dirname, "..", "tasks", "publish-uniffi-local.ts"),
      "utf8",
    );
    assert.match(localCargo, /"metadata", "--format-version", "1", "--no-deps", "--locked"/);
    assert.match(localCargo, /"run",\s*"--no-project",\s*"python"/);
    assert.ok(localCargo.includes("if (workspaceDependency) visit(workspaceDependency)"));
    assert.ok(
      releasePr.indexOf("generateReleaseSummary({") <
        releasePr.indexOf('git(releaseRoot, ["add", "-A"])'),
    );
    assert.ok(
      releasePr.indexOf("generateReleaseSummary({") < releasePr.indexOf("if (opts.approve)"),
    );
    assert.match(releasePr, /"pr",\s*"create"/);
    assert.ok(releasePr.includes('"--no-approve",'));
    assert.ok(releasePr.includes('"--no-wait",'));
    assert.ok(releasePr.includes('"--no-validate",'));
    assert.ok(releasePr.includes('"--no-local-publish",'));
    assert.match(releasePr, /"pr",\s*"merge",\s*releaseBranch,\s*"--auto",\s*"--merge"/);
    assert.match(releasePr, /"pr",\s*"checks",[\s\S]*"--watch",[\s\S]*"--required"/);
    assert.match(releasePr, /"run",\s*"watch",\s*runId,\s*"--exit-status"/);
    assert.match(releasePr, /"--commit",\s*mergeSha/);
    assert.doesNotMatch(
      releasePr,
      /repos\/\$\{account\.owner\}\/\$\{account\.repository\}\/merges/,
    );
    assert.doesNotMatch(releasePr, /"--admin"/);
  });

  it("publishes reviewed versions without repairing manifests", () => {
    const driver = readFileSync(join(import.meta.dirname, "..", "tasks", "publish.ts"), "utf8");
    assert.doesNotMatch(driver, /--stamp-only|pm", "pkg", "set/);
    assert.ok(driver.includes("workspace manifests do not match the reviewed release plan"));
  });
});

describe("generated workflow safety", () => {
  for (const name of ["build"]) {
    it(`${name} is read-only and cancels superseded runs`, () => {
      const workflow = readWorkflow(outdir, name);
      assert.deepEqual(workflow.permissions, { contents: "read" });
      assert.deepEqual(workflow.concurrency, {
        group: "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
        "cancel-in-progress": true,
      });
    });
  }

  it("keeps CI separate from release", () => {
    const build = readWorkflow(outdir, "build");
    assert.deepEqual(workflowTrigger(build, "pull_request"), {
      types: ["opened", "synchronize", "reopened", "closed"],
    });
    assert.equal("push" in build.on, false);
    assert.equal(
      build.jobs.build?.if,
      "${{ github.event_name != 'pull_request' || github.event.action != 'closed' }}",
    );
    assert.equal(step(build.jobs.build!, "pr:validate").run, "bunx projen pr:validate");
    const tasks = JSON.parse(readFileSync(join(outdir, ".projen/tasks.json"), "utf8")) as {
      tasks: Record<string, { steps?: Array<{ exec?: string }> }>;
    };
    assert.deepEqual(
      tasks.tasks["pr:validate"]?.steps?.map((taskStep) => taskStep.exec),
      ["bunx projen default", "bun run compile"],
    );

    assert.equal(build.jobs["pr-title"]?.name, "Validate PR title");
    assert.equal(
      build.jobs["pr-title"]?.if,
      "${{ github.event_name == 'pull_request' && github.event.action != 'closed' }}",
    );
    assert.equal(
      step(build.jobs["pr-title"]!, "Validate semantic title").uses,
      "amannn/action-semantic-pull-request@v6",
    );
    assert.deepEqual(step(build.jobs["pr-title"]!, "Validate semantic title").with, {
      types: "feature\nmaintenance",
      requireScope: true,
    });
  });

  it("uses a dependency-only Bun cache key", () => {
    const cacheKey = readFileSync(join(outdir, ".projen", "bun-cache-key.mjs"), "utf8");
    assert.ok(cacheKey.includes("const dependencyFields ="));
    assert.equal(cacheKey.includes('"version"'), false);
    assert.ok(cacheKey.includes('"custom-site"'));
    assert.equal(cacheKey.includes('".docs-build"'), false);
  });
});

describe("optional Node release stage", () => {
  it("rejects inherited native release options at runtime", () => {
    const nativeOptions = {
      name: "native-release-fixture",
      outdir: mkdtempSync(join(tmpdir(), "native-release-option-")),
      release: true,
    } as unknown as ConstructorParameters<typeof DBXToolsNodeProject>[0];
    try {
      assert.throws(() => new DBXToolsNodeProject(nativeOptions), /native Projen release option/);
    } finally {
      rmSync(nativeOptions.outdir, { recursive: true, force: true });
    }
  });

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
      assert.ok(workflow.jobs["verify-context"]);
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
        pullRequestTitlePolicy: false,
      });
      project.synth();
      const workflow = readWorkflow(disabledOutdir, "build");
      assert.equal(workflow.jobs["pr-title"], undefined);
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

  it("generates Release Please planning without allocating Rust jobs for Node-only roots", () => {
    const independentOutdir = mkdtempSync(join(tmpdir(), "release-independent-"));
    try {
      writeFileSync(join(independentOutdir, ".release-please-manifest.json"), "{}\n");
      const project = new DBXToolsNodeProject({
        name: "independent-release-fixture",
        outdir: independentOutdir,
        github: true,
        buildWorkflow: true,
        defaultTagMixins: false,
        versioningMode: "independent",
        releaseSyncBranch: "dev",
        releaseDocs: {
          siteUrl: "https://docs.example.com",
          base: "/",
          prepareSteps: [],
          buildSteps: [],
          artifactPath: "site/dist",
        },
      });
      project.synth();
      const workflow = readWorkflow(independentOutdir);
      assert.ok(workflow.jobs["release-please"]);
      const docsDetection =
        step(workflow.jobs["release-please"]!, "Detect documentation changes").run ?? "";
      assert.match(docsDetection, /exclude\)docs\/releases/);
      assert.match(docsDetection, /exclude\)\.release-notes/);
      assert.ok(workflow.jobs["release-plan"]);
      assert.ok(workflow.jobs["publish-node"]);
      assert.ok(workflow.jobs["publication-complete"]);
      assert.equal(workflow.jobs["build-docs"]?.env?.DOCS_SITE_URL, "https://docs.example.com");
      assert.equal(workflow.jobs["build-docs"]?.env?.DOCS_BASE, "/");
      assert.equal(
        workflow.jobs["deploy-docs"]?.if,
        "${{ always() && needs['build-docs'].result == 'success' }}",
      );
      const sync = workflow.jobs["sync-release-branch"];
      assert.equal(sync?.needs, "publication-complete");
      const syncScript = step(sync!, "Safely sync dev").run ?? "";
      assert.match(syncScript, /merge-base --is-ancestor/);
      assert.match(syncScript, /origin\/\$RELEASE_BRANCH/);
      assert.match(syncScript, /git merge --no-ff --no-edit/);
      assert.match(syncScript, /git merge --abort/);
      assert.match(syncScript, /no longer exists/);
      assert.equal("verify-context" in workflow.jobs, false);
      assert.equal("rust-build" in workflow.jobs, false);
      assert.equal(workflow.jobs["publish-node"]?.needs, "release-plan");
      const reconcile =
        step(workflow.jobs["release-please"]!, "Reconcile generated release PR files").run ?? "";
      assert.match(reconcile, /gh pr merge "\$BRANCH" --merge/);
      assert.match(reconcile, /attempt \$ATTEMPT\/15/);
      assert.match(reconcile, /gh workflow run release\.yml.*automatic=true/);
      assert.match(workflow.jobs["release-please"]?.if ?? "", /inputs\.automatic/);
      assert.match(workflow.jobs["release-plan"]?.if ?? "", /inputs\.automatic != true/);
      const requestWorkflow = readWorkflow(independentOutdir, "release-request");
      assert.match(
        step(requestWorkflow.jobs.request!, "Create, merge, and release source pull request").run ??
          "",
        /gh pr create/,
      );
      assert.match(
        step(requestWorkflow.jobs.request!, "Create, merge, and release source pull request").run ??
          "",
        /gh pr merge "\$PR" --merge/,
      );
      assert.match(
        step(requestWorkflow.jobs.request!, "Create, merge, and release source pull request").run ??
          "",
        /gh workflow run release\.yml.*automatic=true/,
      );
      const tasks = JSON.parse(
        readFileSync(join(independentOutdir, ".projen/tasks.json"), "utf8"),
      ) as { tasks: Record<string, { steps?: Array<{ exec?: string }> }> };
      assert.match(tasks.tasks.release?.steps?.[0]?.exec ?? "", /release-request\.ts/);
      assert.match(tasks.tasks["release:refresh"]?.steps?.[0]?.exec ?? "", /release-please\.ts/);
      const build = readWorkflow(independentOutdir, "build");
      const pullRequest = workflowTrigger(build, "pull_request") as {
        paths?: string[];
      };
      assert.ok(pullRequest.paths?.includes("!.release-units/**"));
      assert.ok(pullRequest.paths?.includes("!**/package.json"));
    } finally {
      rmSync(independentOutdir, { recursive: true, force: true });
    }
  });
});
