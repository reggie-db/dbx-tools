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
  it("tries Cursor, then Codex, then Claude and stops at the first summary", async () => {
    const calls: string[] = [];
    const selected = await selectReleaseSummary("/repo", "prompt", (provider) => {
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

  it("skips summary generation when every provider is unavailable", async () => {
    assert.equal(await selectReleaseSummary("/repo", "prompt", () => undefined), undefined);
  });

  it("supports a configured provider subset", async () => {
    const calls: string[] = [];
    const selected = await selectReleaseSummary(
      "/repo",
      "prompt",
      (provider) => {
        calls.push(provider.name);
        return "Summary";
      },
      ["claude"],
    );
    assert.deepEqual(calls, ["claude"]);
    assert.equal(selected?.provider, "claude");
  });

  it("writes an AI summary and replaces stale content with a Git fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-summary-"));
    const output = join(root, releaseSummaryFile("1.2.3"));
    try {
      const content = await generateReleaseSummary({
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
      const fallback = await generateReleaseSummary({
        root,
        version: "1.2.4",
        runner: () => undefined,
      });
      assert.equal(
        fallback,
        "# Release 1.2.4\n\n" +
          "dbx-tools 1.2.4 contains the reviewed changes listed below.\n\n" +
          "## Changes\n" +
          "- Release metadata updated.\n",
      );
      assert.equal(readFileSync(nextOutput, "utf8"), fallback);
      assert.equal(readFileSync(output, "utf8"), content);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses custom notes without invoking an AI provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-summary-custom-"));
    let providers = 0;
    try {
      const content = await generateReleaseSummary({
        root,
        component: "node-appkit",
        version: "1.2.5",
        customSummary: "Operator-authored release notes.",
        runner: () => {
          providers++;
          return "unexpected";
        },
      });
      assert.equal(providers, 0);
      assert.equal(content, "# Release node-appkit 1.2.5\n\nOperator-authored release notes.\n");
      assert.equal(
        readFileSync(join(root, releaseSummaryFile("1.2.5", "node-appkit")), "utf8"),
        content,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
