import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { parseReleaseTagAnnotation } from "../src/release-options.ts";
import { githubRepositoryFromRemoteUrl, runRelease } from "../tasks/release.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(): { remote: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), "release-tag-"));
  const remote = join(base, "remote.git");
  const root = join(base, "repo");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  git(root, "config", "user.name", "Release Test");
  git(root, "config", "user.email", "release@example.com");
  git(root, "config", "core.hooksPath", "/dev/null");
  writeFileSync(join(root, "VERSION"), "1.0.0\n");
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", private: true, scripts: { bump: "node bump.mjs", "version:check": "true" } }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "bump.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync("VERSION", "1.0.1\\n");',
      'writeFileSync("generated.txt", "1.0.1\\n");',
      "",
    ].join("\n"),
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "--set-upstream", "origin", "main");
  return { remote, root };
}

describe("direct release tags", () => {
  it("recognizes GitHub HTTPS, SSH, and configured SSH aliases", () => {
    assert.equal(
      githubRepositoryFromRemoteUrl("https://github.com/reggie-db/dbx-tools.git"),
      "reggie-db/dbx-tools",
    );
    assert.equal(
      githubRepositoryFromRemoteUrl("git@github.com:reggie-db/dbx-tools.git"),
      "reggie-db/dbx-tools",
    );
    assert.equal(
      githubRepositoryFromRemoteUrl("git@github-reggie-db:reggie-db/dbx-tools.git"),
      "reggie-db/dbx-tools",
    );
    assert.equal(githubRepositoryFromRemoteUrl("/tmp/remote.git"), undefined);
  });

  it("carries task selections through the pushed annotation and skips optional checks", async () => {
    const { remote, root } = fixture();
    try {
      await runRelease({
        root,
        branch: "main",
        prefix: "v",
        remote: "origin",
        publish: "pypi",
        docs: false,
        validation: false,
        validationTasks: ["missing-task"],
        install: "never",
        localPublish: false,
        releaseNotes: false,
      });
      const annotation = git(remote, "for-each-ref", "--format=%(contents)", "refs/tags/v1.0.1");
      assert.deepEqual(parseReleaseTagAnnotation(annotation), {
        npm: false,
        pypi: true,
        docs: false,
        validation: false,
      });
      const output = join(root, "actions-output");
      execFileSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "../tasks/release-options.ts"),
          "--tag",
          "v1.0.1",
          "--output",
          output,
        ],
        { cwd: root },
      );
      assert.equal(
        readFileSync(output, "utf8"),
        "npm=false\npypi=true\ndocs=false\nvalidation=false\n",
      );
      assert.equal(
        git(root, "rev-parse", "v1.0.1^{commit}"),
        git(remote, "rev-parse", "refs/heads/main"),
      );
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });
  it("commits the local bump, pushes main, and pushes an annotated tag", async () => {
    const { remote, root } = fixture();
    try {
      assert.equal(
        await runRelease({
          root,
          branch: "main",
          prefix: "v",
          remote: "origin",
          localPublish: false,
          releaseNotes: false,
        }),
        "v1.0.1",
      );
      assert.equal(git(root, "log", "-1", "--pretty=%s"), "chore(release): 1.0.1");
      assert.equal(git(root, "cat-file", "-t", "v1.0.1"), "tag");
      assert.equal(
        git(root, "rev-parse", "v1.0.1^{commit}"),
        git(remote, "rev-parse", "refs/heads/main"),
      );
      assert.equal(
        git(remote, "rev-parse", "refs/tags/v1.0.1^{commit}"),
        git(root, "rev-parse", "HEAD"),
      );
      assert.equal(readFileSync(join(root, "VERSION"), "utf8"), "1.0.1\n");
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });

  it("runs demo:deploy after tagging when requested", async () => {
    const { remote, root } = fixture();
    try {
      writeFileSync(
        join(root, "package.json"),
        `${JSON.stringify(
          {
            name: "fixture",
            private: true,
            scripts: {
              bump: "node bump.mjs",
              "version:check": "true",
              "demo:deploy": "touch demo-deployed",
            },
          },
          null,
          2,
        )}\n`,
      );
      git(root, "add", "package.json");
      git(root, "commit", "-m", "add demo:deploy");
      await runRelease({
        root,
        branch: "main",
        prefix: "v",
        remote: "origin",
        localPublish: false,
        demoDeploy: true,
        releaseNotes: false,
      });
      assert.equal(readFileSync(join(root, "demo-deployed"), "utf8"), "");
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });

  it("runs the ESLint fixer before validation and writes notes afterward", async () => {
    const { root } = fixture();
    try {
      writeFileSync(
        join(root, "package.json"),
        `${JSON.stringify(
          {
            name: "fixture",
            private: true,
            scripts: {
              bump: "node bump.mjs",
              "version:check": "true",
              "eslint:fix": "touch lint-fixed",
              validate: "test -f lint-fixed && touch validated",
            },
          },
          null,
          2,
        )}\n`,
      );
      await runRelease({
        root,
        branch: "main",
        prefix: "v",
        remote: "origin",
        localPublish: false,
        validationTasks: ["validate"],
        writeReleaseNotes: ({ root: notesRoot, version }) => {
          assert.equal(readFileSync(join(notesRoot, "validated"), "utf8"), "");
          const destination = join(notesRoot, "docs", "releases", `v${version}.md`);
          mkdirSync(join(notesRoot, "docs", "releases"), { recursive: true });
          writeFileSync(destination, `# Release ${version}\n`);
          return destination;
        },
      });
      assert.equal(readFileSync(join(root, "lint-fixed"), "utf8"), "");
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });

  it("can use an existing bump when explicitly requested", async () => {
    const { remote, root } = fixture();
    try {
      writeFileSync(join(root, "VERSION"), "1.0.1\n");
      writeFileSync(join(root, "generated.txt"), "1.0.1\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "chore(release): 1.0.1");
      assert.equal(
        await runRelease({
          root,
          branch: "main",
          bump: false,
          prefix: "v",
          remote: "origin",
          localPublish: false,
          releaseNotes: false,
        }),
        "v1.0.1",
      );
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });

  it("commits Genie or fallback release notes with the version bump", async () => {
    const { root } = fixture();
    let releaseNotesInstructions: string | undefined;
    try {
      git(root, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
      await runRelease({
        root,
        branch: "main",
        prefix: "v",
        remote: "origin",
        localPublish: false,
        releaseNotesInstructions: "Focus on operator-visible changes.",
        writeReleaseNotes: ({ root: notesRoot, version, instructions }) => {
          releaseNotesInstructions = instructions;
          const dest = join(notesRoot, "docs", "releases", `v${version}.md`);
          mkdirSync(join(notesRoot, "docs", "releases"), { recursive: true });
          writeFileSync(dest, `# Release ${version}\n\nGenie notes.\n`);
          return dest;
        },
      });
      assert.equal(
        readFileSync(join(root, "docs/releases/v1.0.1.md"), "utf8"),
        "# Release 1.0.1\n\nGenie notes.\n",
      );
      assert.equal(releaseNotesInstructions, "Focus on operator-visible changes.");
      assert.match(git(root, "ls-tree", "-r", "--name-only", "HEAD"), /docs\/releases\/v1.0.1.md/);
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });

  it("commits and pushes a feature branch before fast-forwarding main", async () => {
    const { remote, root } = fixture();
    try {
      git(root, "switch", "-c", "feature");
      writeFileSync(join(root, "feature.txt"), "feature\n");
      assert.equal(
        await runRelease({
          root,
          branch: "main",
          prefix: "v",
          remote: "origin",
          localPublish: false,
          releaseNotes: false,
        }),
        "v1.0.1",
      );
      assert.equal(git(root, "branch", "--show-current"), "main");
      assert.equal(git(root, "log", "feature", "-1", "--pretty=%s"), "chore: prepare release");
      assert.equal(
        git(remote, "rev-parse", "refs/heads/feature"),
        git(root, "rev-parse", "feature"),
      );
      assert.equal(git(remote, "rev-parse", "refs/heads/main"), git(root, "rev-parse", "HEAD"));
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });

  it("rejects a feature branch that cannot safely fast-forward main", async () => {
    const { root } = fixture();
    try {
      git(root, "switch", "-c", "feature");
      writeFileSync(join(root, "feature.txt"), "feature\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "feature");
      git(root, "switch", "main");
      writeFileSync(join(root, "main.txt"), "main\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "main advance");
      git(root, "push", "origin", "main");
      git(root, "switch", "feature");
      await assert.rejects(
        () =>
          runRelease({
            root,
            branch: "main",
            prefix: "v",
            remote: "origin",
            localPublish: false,
            releaseNotes: false,
          }),
        /cannot safely merge feature into main/,
      );
      assert.equal(git(root, "branch", "--show-current"), "feature");
      assert.equal(git(root, "rev-parse", "feature"), git(root, "rev-parse", "origin/feature"));
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });

  it("fails when the branch cannot fast-forward main", async () => {
    const { root } = fixture();
    try {
      // Advance origin/main past the local tip so a fast-forward is impossible.
      writeFileSync(join(root, "ahead.txt"), "remote\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "remote advance");
      git(root, "push", "origin", "main");
      git(root, "reset", "--hard", "HEAD~1");
      await assert.rejects(
        () =>
          runRelease({
            root,
            branch: "main",
            prefix: "v",
            remote: "origin",
            localPublish: false,
            releaseNotes: false,
          }),
        /fast-forward/,
      );
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });
});
