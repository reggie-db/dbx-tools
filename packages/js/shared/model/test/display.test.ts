import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toModelDisplayName } from "../src/display.ts";

describe("toModelDisplayName", () => {
  it("strips a leading databricks prefix and dots the version", () => {
    assert.equal(toModelDisplayName("databricks-claude-sonnet-4-6"), "Claude Sonnet 4.6");
  });

  it("strips the system.ai namespace and uppercases acronyms", () => {
    assert.equal(toModelDisplayName("system.ai.bge_large_en"), "BGE Large En");
  });

  it("uppercases GPT/OSS and glues the size unit", () => {
    assert.equal(toModelDisplayName("databricks-gpt-oss-120b"), "GPT OSS 120B");
  });

  it("restores AI casing", () => {
    assert.equal(toModelDisplayName("databricks-ai-router"), "AI Router");
  });

  it("joins multi-part version runs with dots", () => {
    assert.equal(
      toModelDisplayName("databricks-meta-llama-3-3-70b-instruct"),
      "Meta Llama 3.3 70B Instruct",
    );
  });

  it("prefers a Databricks-provided name verbatim", () => {
    assert.equal(
      toModelDisplayName("databricks-claude-sonnet-4-6", "Claude Sonnet 4.6 (Preview)"),
      "Claude Sonnet 4.6 (Preview)",
    );
  });

  it("ignores a blank provided name and falls back to the derived label", () => {
    assert.equal(toModelDisplayName("databricks-gpt-5-5", "   "), "GPT 5.5");
  });

  it("title-cases a bare vendor token when nothing else remains", () => {
    // Only leading vendor prefixes are stripped, and never the last
    // remaining token, so a name that is *only* a vendor word stays.
    assert.equal(toModelDisplayName("databricks"), "Databricks");
  });
});
