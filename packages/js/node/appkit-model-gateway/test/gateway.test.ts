import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelTarget } from "@dbx-tools/shared-model-gateway";

import {
  adaptInferenceTemperature,
  gatewayModelSelection,
  ModelGateway,
  ModelGatewayError,
  sanitizeInferenceBody,
} from "../src/gateway.ts";
import type { ModelRegistry } from "../src/registry.ts";
import { SmartRouterService } from "../src/smart-router.ts";

const SMART_ROUTER_SETTINGS = {
  contextTokenBudget: 1_024,
  probeRefreshIntervalMs: 60_000,
  probeTtlMs: 60_000,
  routeTtlSeconds: 600,
  routerName: "task_v3",
  timeoutMs: 1_000,
} as const;

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
    const gateway = new ModelGateway({ smartRouter: "false" }, registry);

    const response = await gateway.models(undefined, "gte large");

    assert.deepEqual(calls, ["gte large"]);
    assert.equal("data" in response ? response.data[0]?.id : undefined, target.id);
  });

  it("publishes smart-router after its capability probe succeeds", async () => {
    const target = chatTarget();
    const registry: ModelRegistry = {
      async list() {
        return [target];
      },
      async search() {
        return [target];
      },
      async resolve() {
        return target;
      },
      async refresh() {},
    };
    const service = new (class extends SmartRouterService {
      override isEnabled<T>(): Promise<boolean> {
        return Promise.resolve(true);
      }
    })(SMART_ROUTER_SETTINGS);
    const gateway = new ModelGateway({ smartRouterService: service }, registry);

    const standard = await gateway.models();
    const codex = await gateway.models("codex_cli_rs");

    assert.equal("data" in standard ? standard.data[0]?.id : undefined, "smart-router");
    assert.equal("models" in codex ? codex.models[0]?.slug : undefined, "databricks/smart-router");
  });

  it("fails model discovery when Smart Router is required but unavailable", async () => {
    const target = chatTarget();
    const registry: ModelRegistry = {
      async list() {
        return [target];
      },
      async search() {
        return [target];
      },
      async resolve() {
        return target;
      },
      async refresh() {},
    };
    const service = new (class extends SmartRouterService {
      override isEnabled<T>(): Promise<boolean> {
        return Promise.resolve(false);
      }
    })(SMART_ROUTER_SETTINGS);
    const gateway = new ModelGateway(
      { smartRouter: "true", smartRouterService: service },
      registry,
    );

    await assert.rejects(() => gateway.models(), /required but unavailable/);
  });
});

describe("ModelGateway request sanitization", () => {
  it("selects by explicit model, class header, configured default, or empty best-chat input", () => {
    assert.deepEqual(gatewayModelSelection({}, new Headers()), {});
    assert.deepEqual(
      gatewayModelSelection({}, new Headers({ "x-dbx-tools-model-class": "chat-fast" })),
      { modelClass: "chat-fast" },
    );
    assert.deepEqual(gatewayModelSelection({}, new Headers(), { modelClass: "chat-balanced" }), {
      modelClass: "chat-balanced",
    });
    assert.deepEqual(gatewayModelSelection({ model: "gpt" }, new Headers()), {
      model: "gpt",
    });
    assert.deepEqual(gatewayModelSelection({ model: "smart-router" }, new Headers()), {
      smartRouter: true,
    });
    assert.deepEqual(gatewayModelSelection({ model: "databricks/smart-router" }, new Headers()), {
      smartRouter: true,
    });
    assert.throws(
      () =>
        gatewayModelSelection(
          { model: "gpt" },
          new Headers({ "x-dbx-tools-model-class": "chat-fast" }),
        ),
      /mutually exclusive/,
    );
  });

  it("omits a null temperature without mutating the caller body", () => {
    const body = { model: "chat", temperature: null, stream: true };

    assert.deepEqual(sanitizeInferenceBody(body), {
      model: "chat",
      stream: true,
    });
    assert.equal(body.temperature, null);
  });

  it("preserves numeric and omitted temperatures", () => {
    const numeric = { model: "chat", temperature: 1 };
    const omitted = { model: "chat" };

    assert.equal(sanitizeInferenceBody(numeric), numeric);
    assert.equal(sanitizeInferenceBody(omitted), omitted);
  });

  it("rejects explicit nonnumeric or nonfinite temperatures", () => {
    for (const temperature of ["1", {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => sanitizeInferenceBody({ model: "chat", temperature }),
        (error) => error instanceof ModelGatewayError && error.status === 400,
      );
    }
  });

  it("clamps temperature for models.dev-supported Databricks models", () => {
    assert.deepEqual(adaptInferenceTemperature("databricks-gpt-5-4", { temperature: -1 }), {
      temperature: 0,
    });
    assert.deepEqual(adaptInferenceTemperature("databricks-gpt-5-4", { temperature: 3 }), {
      temperature: 2,
    });
    const supported = { temperature: 1 };
    assert.equal(adaptInferenceTemperature("databricks-gpt-5-4", supported), supported);
  });

  it("omits unsupported temperature and preserves unknown custom models", () => {
    assert.deepEqual(adaptInferenceTemperature("databricks-gpt-5-5", { temperature: 1 }), {});
    const custom = { temperature: 3 };
    const omitted = { model: "custom-model" };
    assert.equal(adaptInferenceTemperature("custom-model", custom), custom);
    assert.equal(adaptInferenceTemperature("databricks-gpt-5-4", omitted), omitted);
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
      imageInput: false,
      applyPatch: false,
    },
    reasoningEfforts: [],
  };
}

function chatTarget(): ModelTarget {
  return {
    id: "databricks-gpt-oss-120b",
    aliases: ["databricks-gpt-oss-120b"],
    displayName: "GPT OSS 120B",
    endpoint: {
      name: "databricks-gpt-oss-120b",
      task: "llm/v1/chat",
      class: "chat-balanced",
      status: { deprecated: false },
    },
    capabilities: {
      responses: true,
      openResponses: true,
      chat: true,
      anthropic: false,
      embeddings: false,
      aiGatewayCodex: true,
      tools: true,
      reasoning: true,
      streaming: true,
      parallelTools: true,
      customTools: true,
      structuredOutput: true,
      webSearch: false,
      imageInput: false,
      applyPatch: true,
    },
    reasoningEfforts: ["low", "medium", "high"],
  };
}
