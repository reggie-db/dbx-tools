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
    const prompt = releaseNotesPrompt({
      instructions: "  Focus on operator-visible changes.  ",
      prefix: "v",
      successfulTag: "v1.0.0",
    });

    assert.match(prompt, /Compare v1\.0\.0\.\.HEAD plus the working tree/);
    assert.match(prompt, /newer v\* tags and their release-note files as failed release attempts/);
    assert.match(prompt, /Do not reduce the notes to retry-only deployment or workflow fixes/);
    assert.match(prompt, /do not run tests or other validation commands/);
    assert.match(prompt, /Additional instructions:\nFocus on operator-visible changes\.$/);
  });

  it("does not assume the newest tag deployed when no successful baseline exists", () => {
    const prompt = releaseNotesPrompt({ prefix: "release-" });

    assert.match(prompt, /No successful GitHub release workflow baseline was found/);
    assert.match(prompt, /Do not assume the latest release-\* tag deployed successfully/);
    assert.match(prompt, /produce cumulative notes/);
  });

  it("keeps Genie output when exec succeeds and writes a file", () => {
    const root = fixture();
    try {
      const destination = writeReleaseNotes({
        prefix: "v",
        root,
        successfulTag: "v1.0.0",
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
          assert.match(args[8]!, /Compare v1\.0\.0\.\.HEAD plus the working tree/);
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

  it("writes supplied content without invoking Genie", () => {
    const root = fixture();
    try {
      const destination = writeReleaseNotes({
        content: "# Release 1.0.1\n\nSupplied notes.",
        prefix: "v",
        root,
        successfulTag: "v1.0.0",
        version: "1.0.1",
        runGenie: () => assert.fail("Genie must not run for supplied notes"),
      });
      assert.equal(readFileSync(destination, "utf8"), "# Release 1.0.1\n\nSupplied notes.\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("copies supplied content from a file without invoking Genie", () => {
    const root = fixture();
    try {
      writeFileSync(join(root, "notes.md"), "# Release 1.0.1\n\nFile notes.\n");
      const destination = writeReleaseNotes({
        file: "notes.md",
        prefix: "v",
        root,
        version: "1.0.1",
        runGenie: () => assert.fail("Genie must not run for supplied notes"),
      });
      assert.equal(readFileSync(destination, "utf8"), "# Release 1.0.1\n\nFile notes.\n");
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
        successfulTag: "v1.0.0",
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
