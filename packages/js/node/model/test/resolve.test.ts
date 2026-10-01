import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CacheManager } from "@databricks/appkit";
import { model, type ServingEndpointSummary } from "@dbx-tools/shared-model";

import { FALLBACK_MODEL_IDS, modelsForClass } from "../src/fallback.ts";
import {
  clearServingEndpointsCache,
  listServingEndpoints,
  listServingEndpointsUncached,
  resolveModelId,
  searchServingEndpoints,
  type WorkspaceClientLike,
} from "../src/model-catalog.ts";
import { lookupModels, resolveModel, selectModel } from "../src/resolve.ts";

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

  it("uses the same version-aware Rust ranking as lookupModels", () => {
    const versions = [chat(OPUS_6), chat(OPUS_8), chat(OPUS_7)];
    assert.equal(resolveModelId("claude opus", versions).modelId, OPUS_8);
    assert.equal(
      lookupModels(versions, { search: "claude opus", limit: 1 })[0]?.endpoint.name,
      OPUS_8,
    );
  });

  it("searches explicit custom endpoint records through the Rust ranker", () => {
    const custom = { name: "approved-custom-endpoint" };
    assert.deepEqual(searchServingEndpoints("approved custom", [custom]), [
      { endpoint: custom, score: 0 },
    ]);
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

describe("listServingEndpointsUncached model policy", () => {
  it("exposes Rust-derived family, reasoning, and tool metadata", async () => {
    const client = {
      servingEndpoints: {
        async *list() {
          yield { name: "databricks-gpt-5-3-codex", task: CHAT_TASK };
          yield { name: "databricks-gemini-3-5-flash", task: CHAT_TASK };
          yield {
            name: "databricks-gemini-2-5-pro",
            task: CHAT_TASK,
            tags: [{ key: "display_name", value: "Gemini Pro" }],
            config: {
              served_entities: [
                {
                  entity_name: "databricks-gemini-2-5-pro",
                  foundation_model: {
                    name: "system.ai.gemini-2-5-pro",
                    ai_gateway_model_profile: { quality: 5, speed: 3, cost: 2 },
                  },
                },
              ],
            },
          };
        },
      },
    } as unknown as WorkspaceClientLike;

    const endpoints = await listServingEndpointsUncached(client);
    assert.deepEqual(
      endpoints.map(({ name, family, reasoningEfforts, supportsTools }) => ({
        name,
        family,
        reasoningEfforts,
        supportsTools,
      })),
      [
        {
          name: "databricks-gpt-5-3-codex",
          family: "gpt",
          reasoningEfforts: ["low", "medium", "high"],
          supportsTools: true,
        },
        {
          name: "databricks-gemini-3-5-flash",
          family: "gemini",
          reasoningEfforts: ["minimal", "low", "medium", "high"],
          supportsTools: false,
        },
        {
          name: "databricks-gemini-2-5-pro",
          family: "gemini",
          reasoningEfforts: ["minimal", "low", "medium", "high"],
          supportsTools: false,
        },
      ],
    );
    assert.deepEqual(endpoints[2], {
      name: "databricks-gemini-2-5-pro",
      displayName: "Gemini Pro",
      family: "gemini",
      task: CHAT_TASK,
      supportsTools: false,
      profile: { quality: 5, speed: 3, cost: 2 },
      class: ModelClass.ChatThinking,
      serviceNames: { google: "gemini-2.5-pro" },
      modelServiceName: "system.ai.gemini-2-5-pro",
      reasoningEfforts: ["minimal", "low", "medium", "high"],
      status: { deprecated: true },
    });
  });
});

describe("listServingEndpoints cache identity", () => {
  function catalogue(name: string, calls: { value: number }): WorkspaceClientLike {
    return {
      servingEndpoints: {
        async *list() {
          calls.value += 1;
          yield { name, task: CHAT_TASK };
        },
      },
    } as WorkspaceClientLike;
  }

  it("isolates principals, coalesces one identity, and bypasses when identity is unknown", async () => {
    await CacheManager.getInstance();
    const host = `https://identity-${Date.now()}.example.com`;
    const callsA = { value: 0 };
    const callsB = { value: 0 };
    const clientA = catalogue("principal-a-private", callsA);
    const clientB = catalogue("principal-b-private", callsB);

    const firstA = await listServingEndpoints(clientA, host, { cacheIdentity: "principal-a" });
    const secondA = await listServingEndpoints(clientA, host, { cacheIdentity: "principal-a" });
    const firstB = await listServingEndpoints(clientB, host, { cacheIdentity: "principal-b" });

    assert.deepEqual(
      firstA.map((endpoint) => endpoint.name),
      ["principal-a-private"],
    );
    assert.deepEqual(
      secondA.map((endpoint) => endpoint.name),
      ["principal-a-private"],
    );
    assert.deepEqual(
      firstB.map((endpoint) => endpoint.name),
      ["principal-b-private"],
    );
    assert.equal(callsA.value, 1);
    assert.equal(callsB.value, 1);

    await listServingEndpoints(clientA, host);
    await listServingEndpoints(clientA, host);
    assert.equal(callsA.value, 3);

    await clearServingEndpointsCache(host, "principal-a");
    await listServingEndpoints(clientA, host, { cacheIdentity: "principal-a" });
    await listServingEndpoints(clientB, host, { cacheIdentity: "principal-b" });
    assert.equal(callsA.value, 4);
    assert.equal(callsB.value, 1);
  });
});

describe("model resolution", () => {
  const lookupModelsForContract = (...args: Parameters<typeof lookupModels>) =>
    lookupModels(...args).map(({ endpoint, ...ranked }) => ({
      ...ranked,
      endpoint: { name: endpoint.name, task: endpoint.task },
    }));

  describe("model resolution contract", () => {
    it("ranks by a class ceiling without search", () => {
      assert.deepEqual(
        lookupModelsForContract([chat(OPUS_8), chat(SONNET), chat(HAIKU_5), embedding(BGE)], {
          modelClass: ModelClass.ChatBalanced,
        }),
        [
          { endpoint: chat(SONNET), modelClass: ModelClass.ChatBalanced },
          { endpoint: chat(HAIKU_5), modelClass: ModelClass.ChatFast },
        ],
      );
    });

    it("returns an exact search with score zero", () => {
      assert.deepEqual(
        lookupModelsForContract([chat(OPUS_8), chat(SONNET)], {
          search: SONNET,
          limit: 1,
        }),
        [{ endpoint: chat(SONNET), modelClass: ModelClass.ChatBalanced, score: 0 }],
      );
    });

    it("prefers the newest deployed version for a family alias", () => {
      const [selected] = lookupModelsForContract(
        [
          chat("databricks-gemini-2-5-pro"),
          chat("databricks-gemini-3-5-flash"),
          chat("databricks-gemini-3-1-pro"),
        ],
        { search: "gemini", limit: 1 },
      );
      assert.equal(selected?.endpoint.name, "databricks-gemini-3-5-flash");
    });

    it("prefers the discovered catalogue over the static fallback floor", () => {
      const discovered = "databricks-claude-opus-99";

      assert.deepEqual(resolveModel([chat(discovered)], {}), {
        modelId: discovered,
        source: "fallback",
      });
    });

    it("prefers the newest live GPT over an older scored GPT", () => {
      assert.deepEqual(
        resolveModel(
          [
            {
              ...chat("databricks-gpt-5-4"),
              profile: { quality: 57, speed: 76.9, cost: 5.63 },
            },
            chat("databricks-gpt-6-1-sol"),
          ],
          {},
        ),
        {
          modelId: "databricks-gpt-6-1-sol",
          source: "fallback",
        },
      );
    });

    it("uses the static floor only when discovery returns no chat model", () => {
      assert.deepEqual(resolveModel([], {}), {
        modelId: FALLBACK_MODEL_IDS[0]!,
        source: "fallback",
      });
    });

    it("can require an actually available live endpoint", () => {
      assert.throws(
        () => resolveModel([], { liveOnly: true }),
        /No matching live Model Serving endpoint is available/,
      );
      assert.deepEqual(resolveModel([chat(OPUS_8)], { liveOnly: true }), {
        modelId: OPUS_8,
        source: "fallback",
      });
    });

    it("accepts only operator fallbacks present in discovery", () => {
      const discovered = "databricks-approved-custom";

      assert.deepEqual(resolveModel([chat(discovered)], { fallbacks: ["missing", discovered] }), {
        modelId: discovered,
        source: "fallback",
      });
    });
  });
});

describe("model fallback contract", () => {
  it("keeps the same last-resort model floor", () => {
    assert.deepEqual(FALLBACK_MODEL_IDS, [
      "databricks-gpt-5-5-pro",
      "databricks-claude-opus-4-8",
      "databricks-gemini-3-1-pro",
      "databricks-gpt-5-5",
      "databricks-claude-sonnet-4-6",
      "databricks-meta-llama-3-3-70b-instruct",
      "databricks-gpt-5-nano",
      "databricks-claude-haiku-4-5",
      "databricks-meta-llama-3-1-8b-instruct",
    ]);
  });
});

describe("lookupModels", () => {
  it("ranks a search match-then-class, version breaking the tie", () => {
    const ranked = lookupModels([chat(OPUS_6), chat(OPUS_8), chat(OPUS_7)], {
      search: "opus",
    });
    assert.deepEqual(names(ranked), [OPUS_8, OPUS_7, OPUS_6]);
  });

  it("prefers GPT 5.6 Sol over Luna", () => {
    const ranked = lookupModels([chat("databricks-gpt-5-6-luna"), chat("databricks-gpt-5-6-sol")], {
      search: "gpt",
    });
    assert.deepEqual(names(ranked), ["databricks-gpt-5-6-sol", "databricks-gpt-5-6-luna"]);
  });

  it("with no search, orders by class then within-class rank", () => {
    const ranked = lookupModels(TIERED);
    assert.deepEqual(names(ranked), [OPUS_8, SONNET, HAIKU_5]);
    assert.deepEqual(
      ranked.map((m) => m.modelClass),
      [ModelClass.ChatThinking, ModelClass.ChatBalanced, ModelClass.ChatFast],
    );
  });

  it("excludes embeddings from the default (chat-only) ranking", () => {
    const ranked = lookupModels([chat(OPUS_8), embedding(GTE), embedding(BGE)]);
    assert.deepEqual(names(ranked), [OPUS_8]);
  });

  it("ranks embeddings only when ModelClass.Embedding is requested", () => {
    const ranked = lookupModels([chat(OPUS_8), embedding(GTE), embedding(BGE)], {
      modelClass: ModelClass.Embedding,
    });
    assert.deepEqual(names(ranked), [GTE, BGE]); // no chat model leaks in
  });

  it("treats a chat class as a ceiling: that band and below, never above", () => {
    const ranked = lookupModels(TIERED, { modelClass: ModelClass.ChatBalanced });
    assert.deepEqual(names(ranked), [SONNET, HAIKU_5]); // no opus (ChatThinking)
  });

  it("degrades to a lower band when the requested band is empty", () => {
    // "medium" requested but only "small" exists -> the highest small is
    // returned, never a "large".
    const ranked = lookupModels([chat(OPUS_8), chat(HAIKU_5), chat(HAIKU_3)], {
      modelClass: ModelClass.ChatBalanced,
      limit: 1,
    });
    assert.deepEqual(names(ranked), [HAIKU_5]);
  });

  it("scopes a search to the class ceiling", () => {
    const ranked = lookupModels(TIERED, {
      search: "claude",
      modelClass: ModelClass.ChatFast,
    });
    assert.deepEqual(names(ranked), [HAIKU_5]); // opus / sonnet excluded by ceiling
  });

  it("applies a limit", () => {
    assert.equal(lookupModels(TIERED, { limit: 2 }).length, 2);
  });

  it("filters out chat models without a complete tool round-trip", () => {
    const ranked = lookupModels(
      [
        chat("databricks-gpt-5-6-sol"),
        chat("databricks-gemini-3-5-flash"),
        chat("databricks-gpt-oss-120b"),
      ],
      { requiresTools: true },
    );
    assert.deepEqual(names(ranked), ["databricks-gpt-5-6-sol"]);
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

  it("rejects an explicit model that is not tool-capable", () => {
    assert.throws(
      () =>
        resolveModel([chat("databricks-gemini-3-5-flash")], {
          explicit: "databricks-gemini-3-5-flash",
          fuzzy: false,
          requiresTools: true,
        }),
      /does not support function tools/,
    );
  });

  it("selects only live tool-capable fallbacks", () => {
    const result = resolveModel(
      [chat("databricks-gemini-3-5-flash"), chat("databricks-claude-sonnet-5")],
      {
        fallbacks: ["databricks-gemini-3-5-flash", "databricks-claude-sonnet-5"],
        requiresTools: true,
      },
    );
    assert.deepEqual(result, { modelId: "databricks-claude-sonnet-5", source: "fallback" });
  });
});

describe("selectModel", () => {
  it("checks tool support for an explicit non-fuzzy model", async () => {
    await CacheManager.getInstance();
    const client = {
      servingEndpoints: {
        async *list() {
          yield { name: "databricks-gemini-3-5-flash", task: CHAT_TASK };
        },
      },
    } as WorkspaceClientLike;

    await assert.rejects(
      () =>
        selectModel(client, `https://tools-${Date.now()}.example.com`, {
          explicit: "databricks-gemini-3-5-flash",
          fuzzy: false,
          requiresTools: true,
        }),
      /does not support function tools/,
    );
  });
});
