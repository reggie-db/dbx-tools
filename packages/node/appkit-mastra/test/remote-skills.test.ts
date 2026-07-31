import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AITOOLS_SOURCE,
  normalizeRemoteSkillsOption,
  provisionRemoteSkills,
} from "../src/remote-skills.ts";

describe("normalizeRemoteSkillsOption", () => {
  it("returns undefined for missing / empty input", () => {
    assert.equal(normalizeRemoteSkillsOption(undefined), undefined);
    assert.equal(normalizeRemoteSkillsOption([]), undefined);
    assert.equal(normalizeRemoteSkillsOption({ sources: [] }), undefined);
  });

  it("wraps a bare source string into a single-source bag", () => {
    const normalized = normalizeRemoteSkillsOption("owner/repo");
    assert.deepEqual(normalized, { sources: ["owner/repo"] });
  });

  it("wraps an array of sources", () => {
    const normalized = normalizeRemoteSkillsOption(["owner/repo", "https://x/skill.md"]);
    assert.deepEqual(normalized?.sources, ["owner/repo", "https://x/skill.md"]);
  });

  it("wraps a lone RemoteSkillSourceOptions object", () => {
    const normalized = normalizeRemoteSkillsOption({ source: "owner/repo", failOnError: false });
    assert.deepEqual(normalized?.sources, [{ source: "owner/repo", failOnError: false }]);
  });

  it("passes a full options bag through, normalizing sources to an array", () => {
    const normalized = normalizeRemoteSkillsOption({
      sources: "owner/repo",
      failOnError: false,
      userEmail: "user@example.com",
    });
    assert.deepEqual(normalized, {
      sources: ["owner/repo"],
      failOnError: false,
      userEmail: "user@example.com",
    });
  });

  it("accepts URL-like sources alongside the aitools constant", () => {
    const url = new URL("https://example.com/SKILL.md");
    const normalized = normalizeRemoteSkillsOption([AITOOLS_SOURCE, url, { url: "https://x/y" }]);
    assert.deepEqual(normalized?.sources, [AITOOLS_SOURCE, url, { url: "https://x/y" }]);
  });

  it("exposes aitools as a plain constant callers can spell out", () => {
    assert.equal(AITOOLS_SOURCE, "aitools");
    assert.deepEqual(normalizeRemoteSkillsOption("aitools")?.sources, ["aitools"]);
  });
});

describe("provisionRemoteSkills failure policy", () => {
  it("returns an empty result for no configured sources", async () => {
    const result = await provisionRemoteSkills(undefined);
    assert.deepEqual(result, { localSkillPaths: [], skillNames: [] });
  });

  it("throws when a non-URL source can't resolve and failOnError defaults on", async () => {
    // No `skills` CLI is guaranteed here, and a bare shorthand isn't a URL, so
    // the fetch fallback rejects. With failOnError defaulting to true, startup
    // provisioning should throw and name the offending source.
    await assert.rejects(
      () =>
        provisionRemoteSkills({ sources: ["definitely-not-a-url-shorthand"], client: undefined }),
      /definitely-not-a-url-shorthand/,
    );
  });

  it("skips an unresolvable source when failOnError is false", async () => {
    const result = await provisionRemoteSkills({
      sources: ["definitely-not-a-url-shorthand"],
      failOnError: false,
      client: undefined,
    });
    assert.deepEqual(result.localSkillPaths, []);
    assert.deepEqual(result.skillNames, []);
  });
});
