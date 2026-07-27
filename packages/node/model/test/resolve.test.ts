import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { model, type ServingEndpointSummary } from "@dbx-tools/shared-model";

import { FALLBACK_MODEL_IDS, modelsForClass } from "../src/fallback";
import { rankModels, resolveModel } from "../src/resolve";
import { resolveModelId, searchServingEndpoints } from "../src/serving";

const { ModelClass } = model;

const CHAT_TASK = "llm/v1/chat";
const EMBEDDING_TASK = "llm/v1/embeddings";

/**
 * Unscored chat endpoints classify deterministically by family name (opus ->
 * ChatThinking, sonnet -> ChatBalanced, haiku -> ChatFast), so class membership
 * in these tests doesn't depend on quality quantiles.
 */
function chat(name: string): ServingEndpointSummary {
  return { name, task: CHAT_TASK };
}

/** An embedding endpoint - classified into ModelClass.Embedding by task. */
function embedding(name: string): ServingEndpointSummary {
  return { name, task: EMBEDDING_TASK };
}

const OPUS_8 = "databricks-claude-opus-4-8";
const OPUS_7 = "databricks-claude-opus-4-7";
const OPUS_6 = "databricks-claude-opus-4-6";
const SONNET = "databricks-claude-sonnet-4-6";
const HAIKU_5 = "databricks-claude-haiku-4-5";
const HAIKU_3 = "databricks-claude-haiku-4-3";
const GTE = "databricks-gte-large-en";
const BGE = "databricks-bge-large-en";

/** opus (ChatThinking) / sonnet (ChatBalanced) / haiku (ChatFast) - one per band. */
const TIERED = [chat(OPUS_8), chat(SONNET), chat(HAIKU_5)];

function names(models: { endpoint: ServingEndpointSummary }[]): string[] {
  return models.map((m) => m.endpoint.name);
}

describe("searchServingEndpoints / resolveModelId", () => {
  const endpoints = [chat(OPUS_8), chat(SONNET), chat(HAIKU_5)];

  it("short-circuits an exact name to score 0", () => {
    const [best] = searchServingEndpoints(SONNET, endpoints);
    assert.equal(best?.endpoint.name, SONNET);
    assert.equal(best?.score, 0);
  });

  it("tokenized fuzzy-matches a loose name", () => {
    const result = resolveModelId("claude sonnet", endpoints);
    assert.equal(result.matched, true);
    assert.equal(result.modelId, SONNET);
  });

  it("returns the input verbatim when nothing matches", () => {
    const result = resolveModelId("zzz-no-such-model", endpoints);
    assert.equal(result.matched, false);
    assert.equal(result.modelId, "zzz-no-such-model");
  });

  it("returns [] for an empty catalogue", () => {
    assert.deepEqual(searchServingEndpoints("opus", []), []);
  });
});

describe("rankModels", () => {
  it("ranks a search match-then-class, version breaking the tie", () => {
    const ranked = rankModels([chat(OPUS_6), chat(OPUS_8), chat(OPUS_7)], {
      search: "opus",
    });
    assert.deepEqual(names(ranked), [OPUS_8, OPUS_7, OPUS_6]);
  });

  it("with no search, orders by class then within-class rank", () => {
    const ranked = rankModels(TIERED);
    assert.deepEqual(names(ranked), [OPUS_8, SONNET, HAIKU_5]);
    assert.deepEqual(
      ranked.map((m) => m.modelClass),
      [ModelClass.ChatThinking, ModelClass.ChatBalanced, ModelClass.ChatFast],
    );
  });

  it("excludes embeddings from the default (chat-only) ranking", () => {
    const ranked = rankModels([chat(OPUS_8), embedding(GTE), embedding(BGE)]);
    assert.deepEqual(names(ranked), [OPUS_8]);
  });

  it("ranks embeddings only when ModelClass.Embedding is requested", () => {
    const ranked = rankModels([chat(OPUS_8), embedding(GTE), embedding(BGE)], {
      modelClass: ModelClass.Embedding,
    });
    assert.deepEqual(names(ranked), [GTE, BGE]); // no chat model leaks in
  });

  it("treats a chat class as a ceiling: that band and below, never above", () => {
    const ranked = rankModels(TIERED, { modelClass: ModelClass.ChatBalanced });
    assert.deepEqual(names(ranked), [SONNET, HAIKU_5]); // no opus (ChatThinking)
  });

  it("degrades to a lower band when the requested band is empty", () => {
    // "medium" requested but only "small" exists -> the highest small is
    // returned, never a "large".
    const ranked = rankModels([chat(OPUS_8), chat(HAIKU_5), chat(HAIKU_3)], {
      modelClass: ModelClass.ChatBalanced,
      limit: 1,
    });
    assert.deepEqual(names(ranked), [HAIKU_5]);
  });

  it("scopes a search to the class ceiling", () => {
    const ranked = rankModels(TIERED, {
      search: "claude",
      modelClass: ModelClass.ChatFast,
    });
    assert.deepEqual(names(ranked), [HAIKU_5]); // opus / sonnet excluded by ceiling
  });

  it("applies a limit", () => {
    assert.equal(rankModels(TIERED, { limit: 2 }).length, 2);
  });
});

describe("resolveModel", () => {
  it("fuzzy-resolves an explicit name to the best ranked match (limit 1)", () => {
    const result = resolveModel([chat(OPUS_6), chat(OPUS_8), chat(OPUS_7)], {
      explicit: "opus",
    });
    assert.deepEqual(result, { modelId: OPUS_8, source: "fuzzy-match" });
  });

  it("returns an explicit name verbatim when fuzzy is off", () => {
    const result = resolveModel(TIERED, { explicit: "my-pinned-model", fuzzy: false });
    assert.deepEqual(result, { modelId: "my-pinned-model", source: "explicit" });
  });

  it("resolves a class ask to the top of that band and below", () => {
    const result = resolveModel(TIERED, { modelClass: ModelClass.ChatBalanced });
    assert.deepEqual(result, { modelId: SONNET, source: "class" });
  });

  it("never selects an embedding model for a general (chat) ask", () => {
    const result = resolveModel([embedding(GTE), chat(SONNET)]);
    assert.equal(result.modelId, SONNET);
  });

  it("lets an operator-pinned fallback present in the catalogue win", () => {
    const pinned = "databricks-approved-custom";
    const result = resolveModel([...TIERED, chat(pinned)], { fallbacks: [pinned] });
    assert.deepEqual(result, { modelId: pinned, source: "fallback" });
  });

  it("falls back to the class's static floor for an empty catalogue", () => {
    const result = resolveModel([], { modelClass: ModelClass.ChatBalanced });
    assert.deepEqual(result, {
      modelId: modelsForClass(ModelClass.ChatBalanced)[0]!,
      source: "class",
    });
  });

  it("falls back to the static floor with no intent and an empty catalogue", () => {
    const result = resolveModel([], {});
    assert.deepEqual(result, { modelId: FALLBACK_MODEL_IDS[0]!, source: "fallback" });
  });
});
