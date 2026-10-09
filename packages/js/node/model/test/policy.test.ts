import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compareVersionTuples, versionTuple } from "../src/classify.ts";
import { inheritsNativeWebSearch, modelFamily, ModelFamily } from "../src/policy.ts";

describe("native web-search version inheritance", () => {
  const documented = ["gpt-5", "gpt-5-4", "gemini-3-1-pro"];

  it("parses versions from arbitrary names and compares component-wise", () => {
    assert.deepEqual(versionTuple("databricks-claude-opus-4-8"), [4, 8, 0]);
    assert.deepEqual(versionTuple("databricks-claude-opus-4-10"), [4, 10, 0]);
    assert.deepEqual(versionTuple("system.ai.gpt-6-1-sol"), [6, 1, 0]);
    assert.deepEqual(versionTuple("databricks-meta-llama-3-3-70b"), [3, 3, 70]);
    assert.ok(compareVersionTuples(versionTuple("opus-4-10"), versionTuple("opus-4-8")) > 0);
    assert.equal(compareVersionTuples(versionTuple("gpt-5"), versionTuple("gpt-5-0")), 0);
  });

  it("enables later intra-family versions than the documented floor", () => {
    assert.equal(inheritsNativeWebSearch("databricks-gpt-5-4", documented), true);
    assert.equal(inheritsNativeWebSearch("databricks-gpt-5", documented), true);
    assert.equal(inheritsNativeWebSearch("databricks-gpt-6-1-sol", documented), true);
    assert.equal(inheritsNativeWebSearch("system.ai.gpt-7-future", documented), true);
    assert.equal(inheritsNativeWebSearch("custom-gpt-5-5-endpoint", documented), true);
    assert.equal(inheritsNativeWebSearch("databricks-gemini-3-1-flash-lite", documented), true);
    assert.equal(inheritsNativeWebSearch("databricks-gemini-4-pro", documented), true);
  });

  it("does not enable older versions, other families, or GPT-OSS", () => {
    assert.equal(inheritsNativeWebSearch("databricks-gpt-4", documented), false);
    assert.equal(inheritsNativeWebSearch("databricks-gpt-oss-120b", documented), false);
    assert.equal(inheritsNativeWebSearch("databricks-claude-sonnet-4-6", documented), false);
    assert.equal(inheritsNativeWebSearch("databricks-gemini-2-5-pro", documented), false);
  });
});

describe("model family values", () => {
  it("returns typed family values from model identities", () => {
    assert.equal(modelFamily("databricks-gpt-6-1-sol"), ModelFamily.Gpt);
    assert.equal(modelFamily("databricks-gemini-3-8-flash"), ModelFamily.Gemini);
    assert.equal(modelFamily("custom-endpoint"), undefined);
  });
});
