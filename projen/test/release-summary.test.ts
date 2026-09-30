import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { releaseSummaryFile } from "../src/release-dispatch.ts";
import {
  generateReleaseSummary,
  RELEASE_SUMMARY_PROVIDERS,
  selectReleaseSummary,
} from "../tasks/release-summary.ts";

describe("optional release summary providers", () => {
  it("tries Cursor, then Codex, then Claude and stops at the first summary", () => {
    const calls: string[] = [];
    const selected = selectReleaseSummary("/repo", "prompt", (provider) => {
      calls.push(provider.name);
      return provider.name === "codex" ? "Release summary" : undefined;
    });

    assert.deepEqual(
      RELEASE_SUMMARY_PROVIDERS.map((provider) => provider.name),
      ["cursor", "codex", "claude"],
    );
    assert.deepEqual(calls, ["cursor", "codex"]);
    assert.deepEqual(selected, { provider: "codex", summary: "Release summary" });
  });

  it("skips summary generation when every provider is unavailable", () => {
    assert.equal(
      selectReleaseSummary("/repo", "prompt", () => undefined),
      undefined,
    );
  });

  it("writes a summary and removes stale content when providers are unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "release-summary-"));
    const output = join(root, releaseSummaryFile("1.2.3"));
    try {
      const content = generateReleaseSummary({
        root,
        version: "1.2.3",
        runner: (provider) =>
          provider.name === "cursor"
            ? "A concise summary.\n\n## Changes\n- Added a feature."
            : undefined,
      });
      assert.equal(
        content,
        "# Release 1.2.3\n\nA concise summary.\n\n## Changes\n- Added a feature.\n",
      );
      assert.equal(readFileSync(output, "utf8"), content);

      const nextOutput = join(root, releaseSummaryFile("1.2.4"));
      writeFileSync(nextOutput, "stale");
      assert.equal(
        generateReleaseSummary({
          root,
          version: "1.2.4",
          runner: () => undefined,
        }),
        undefined,
      );
      assert.throws(() => readFileSync(nextOutput, "utf8"));
      assert.equal(readFileSync(output, "utf8"), content);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
