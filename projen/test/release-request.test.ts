import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";

import { isReleasableMessage, prepareReleaseRequest } from "../tasks/release-request.ts";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

describe("release request preparation", () => {
  it("does nothing without changes and persists readable notes only when needed", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-request-"));
    try {
      git(root, "init", "-b", "main");
      git(root, "config", "user.name", "Release Test");
      git(root, "config", "user.email", "release@example.com");
      writeFileSync(join(root, "source.txt"), "base\n");
      git(root, "add", "source.txt");
      git(root, "commit", "-m", "chore: baseline");
      git(root, "switch", "-c", "feature/logging");

      let generated = 0;
      const unchanged = await prepareReleaseRequest({
        root,
        baseBranch: "main",
        push: false,
        synthesize: false,
        generateNotes: async () => {
          generated++;
          return "generated";
        },
      });
      assert.equal(unchanged, false);
      assert.equal(generated, 0);

      writeFileSync(join(root, "source.txt"), "updated\n");
      const requested = await prepareReleaseRequest({
        root,
        baseBranch: "main",
        push: false,
        synthesize: false,
        message: "fix: improve logging",
        notes: "Logging now identifies initialization completion.",
      });
      assert.equal(requested, true);
      assert.equal(
        readFileSync(join(root, ".release-notes/requests/feature-logging.md"), "utf8"),
        [
          "# Release request: feature/logging",
          "",
          "Logging now identifies initialization completion.",
          "",
        ].join("\n"),
      );
      const message = git(root, "log", "-1", "--format=%B");
      assert.match(message, /^Release-Request: true$/m);
      assert.match(
        message,
        /^Release-Notes-Path: \.release-notes\/requests\/feature-logging\.md$/m,
      );
      assert.doesNotMatch(message, /Base64/);

      const repeated = await prepareReleaseRequest({
        root,
        baseBranch: "main",
        push: false,
        synthesize: false,
        generateNotes: async () => {
          generated++;
          return "generated";
        },
      });
      assert.equal(repeated, false);
      assert.equal(generated, 0);
      assert.equal(isReleasableMessage("fix: value"), true);
      assert.equal(isReleasableMessage("chore: value"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
