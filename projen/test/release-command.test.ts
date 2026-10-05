import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runRelease } from "../tasks/release.ts";

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
  it("commits the local bump, pushes main, and pushes an annotated tag", () => {
    const { remote, root } = fixture();
    try {
      assert.equal(
        runRelease({ root, branch: "main", prefix: "v", remote: "origin" }),
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

  it("can use an existing bump when explicitly requested", () => {
    const { remote, root } = fixture();
    try {
      writeFileSync(join(root, "VERSION"), "1.0.1\n");
      writeFileSync(join(root, "generated.txt"), "1.0.1\n");
      assert.equal(
        runRelease({ root, branch: "main", bump: false, prefix: "v", remote: "origin" }),
        "v1.0.1",
      );
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });

  it("refuses to tag a non-release branch", () => {
    const { root } = fixture();
    try {
      git(root, "switch", "-c", "feature");
      assert.throws(
        () => runRelease({ root, branch: "main", prefix: "v", remote: "origin" }),
        /release must run on main/,
      );
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });
});
