import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelTarget } from "@dbx-tools/shared-model-gateway";

import { ModelGateway } from "../src/gateway.ts";
import type { ModelRegistry } from "../src/registry.ts";

describe("ModelGateway model discovery", () => {
  it("uses registry search for the optional models query", async () => {
    const calls: string[] = [];
    const target = embeddingTarget();
    const registry: ModelRegistry = {
      async list() {
        return [];
      },
      async search(query) {
        calls.push(query);
        return [target];
      },
      async resolve() {
        return target;
      },
      async refresh() {},
    };
    const gateway = new ModelGateway({}, registry);

    const response = await gateway.models(undefined, "gte large");

    assert.deepEqual(calls, ["gte large"]);
    assert.equal("data" in response ? response.data[0]?.id : undefined, target.id);
  });
});

function embeddingTarget(): ModelTarget {
  return {
    id: "databricks-gte-large-en",
    aliases: ["gte large"],
    displayName: "GTE Large",
    capabilities: {
      responses: false,
      openResponses: false,
      chat: false,
      anthropic: false,
      embeddings: true,
      aiGatewayCodex: false,
      tools: false,
      reasoning: false,
      streaming: false,
      parallelTools: false,
      customTools: false,
      structuredOutput: false,
      webSearch: false,
    },
    reasoningEfforts: [],
  };
}
