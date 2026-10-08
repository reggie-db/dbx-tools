import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  fallbackReleaseNotes,
  releaseNotesPath,
  releaseNotesPrompt,
  writeReleaseNotes,
} from "../tasks/release-notes.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "release-notes-"));
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  git(root, "config", "user.name", "Release Test");
  git(root, "config", "user.email", "release@example.com");
  git(root, "config", "core.hooksPath", "/dev/null");
  writeFileSync(join(root, "VERSION"), "1.0.0\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  git(root, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
  writeFileSync(join(root, "feature.txt"), "ok\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "feat: ship notes");
  return root;
}

describe("release notes", () => {
  it("appends trimmed custom instructions to the Genie prompt", () => {
    const prompt = releaseNotesPrompt("  Focus on operator-visible changes.  ");

    assert.match(prompt, /Compare HEAD and the working tree/);
    assert.match(prompt, /Additional instructions:\nFocus on operator-visible changes\.$/);
  });

  it("keeps Genie output when exec succeeds and writes a file", () => {
    const root = fixture();
    try {
      const destination = writeReleaseNotes({
        prefix: "v",
        root,
        version: "1.0.1",
        runGenie: (args) => {
          assert.deepEqual(args.slice(0, 7), [
            "exec",
            "-C",
            root,
            "--sandbox",
            "read-only",
            "--ephemeral",
            "-o",
          ]);
          assert.equal(args[7], "docs/releases/v1.0.1.md");
          writeFileSync(join(root, args[7]!), "# Release 1.0.1\n\nGenie wrote this.\n");
          return true;
        },
      });
      assert.equal(destination, releaseNotesPath(root, "1.0.1"));
      assert.equal(readFileSync(destination, "utf8"), "# Release 1.0.1\n\nGenie wrote this.\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to a git-log summary when Genie fails or writes nothing", () => {
    const root = fixture();
    try {
      const destination = writeReleaseNotes({
        prefix: "v",
        root,
        version: "1.0.1",
        runGenie: () => false,
      });
      assert.equal(
        readFileSync(destination, "utf8"),
        fallbackReleaseNotes("1.0.1", ["feat: ship notes"], "v1.0.0"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
