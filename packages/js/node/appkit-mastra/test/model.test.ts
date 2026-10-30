import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";
import { ModelClass, type ServingEndpointSummary } from "@dbx-tools/shared-model";
import { RequestContext } from "@mastra/core/request-context";

import { MASTRA_USER_KEY } from "../src/config.ts";
import {
  buildModel,
  resolveDefaultModelId,
  resolveModelWorkspaceClient,
  RESPONSES_PROVIDER_OPTIONS,
  SMART_ROUTER_ENDPOINT,
  servingApi,
} from "../src/model.ts";
import {
  MASTRA_MODEL_OVERRIDE_KEY,
  MASTRA_MODEL_ROUTE_KEY,
  MASTRA_SMART_ROUTER_INPUT_KEY,
  type MastraModelRoute,
} from "../src/serving.ts";

describe("Mastra serving API selection", () => {
  it("routes Responses-only models through the native Responses provider", () => {
    for (const modelId of [
      "databricks-gpt-6-astra",
      "databricks-gpt-5-6-sol",
      "databricks-gpt-5-5-pro",
      "databricks-gpt-5-4-mini",
      "databricks-gpt-5-3-codex",
    ]) {
      assert.equal(servingApi(modelId), "responses", modelId);
    }
  });

  it("keeps Chat Completions models on the chat provider", () => {
    for (const modelId of [
      "databricks-gpt-oss-120b",
      "databricks-claude-sonnet-4-6",
      "databricks-gemini-3-1-pro",
    ]) {
      assert.equal(servingApi(modelId), "chat", modelId);
    }
  });

  it("keeps Responses tool continuations stateless", () => {
    assert.deepEqual(RESPONSES_PROVIDER_OPTIONS, {
      openai: {
        store: false,
        reasoningSummary: "auto",
      },
    });
  });

  it("falls back to a configured service-principal client outside a request", () => {
    assert.ok(resolveModelWorkspaceClient(new RequestContext()).config);
  });

  it("prefers the request-scoped OBO client", () => {
    const requestContext = new RequestContext();
    const client = { config: {} };
    requestContext.set(MASTRA_USER_KEY, {
      id: "user-1",
      executionContext: { client, isUserContext: true },
    });

    assert.equal(resolveModelWorkspaceClient(requestContext), client);
  });

  it("uses the highest-ranked live model when no default is configured", () => {
    const previous = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    const endpoints: ServingEndpointSummary[] = [
      { name: "databricks-claude-opus-4-7", task: "llm/v1/chat" },
      { name: "databricks-claude-opus-4-8", task: "llm/v1/chat" },
      {
        name: "databricks-gpt-5-4",
        task: "llm/v1/chat",
        profile: { quality: 57, speed: 76.9, cost: 5.63 },
      },
      { name: "databricks-gpt-6-1-sol", task: "llm/v1/chat" },
      { name: "databricks-gte-large-en", task: "llm/v1/embeddings" },
    ];
    try {
      assert.equal(resolveDefaultModelId({}, endpoints), "databricks-gpt-6-1-sol");
    } finally {
      if (previous === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
      else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = previous;
    }
  });

  it("uses Smart Router as the default when its live probe published the virtual endpoint", () => {
    assert.equal(
      resolveDefaultModelId({}, [
        SMART_ROUTER_ENDPOINT,
        { name: "databricks-gpt-6-1-sol", task: "llm/v1/chat" },
      ]),
      "smart-router",
    );
  });

  it("selects an explicit Smart Router model once per request context", async () => {
    const previousFetch = globalThis.fetch;
    let routeCalls = 0;
    let catalogueCalls = 0;
    const client = {
      config: {
        getHost: () => Promise.resolve(new URL("https://example.cloud.databricks.com")),
        authenticate: (headers: Headers) => {
          headers.set("authorization", "Bearer test");
          return Promise.resolve();
        },
      },
      servingEndpoints: {
        async *list() {
          catalogueCalls += 1;
          yield {
            name: "databricks-gpt-6-1-sol",
            task: "llm/v1/chat",
            capabilities: { function_calling: true },
            config: {
              served_entities: [
                {
                  entity_name: "system.ai.databricks-gpt-6-1-sol",
                  foundation_model: {
                    name: "system.ai.databricks-gpt-6-1-sol",
                    ai_gateway_model_profile: { cost: 3.5 },
                  },
                },
              ],
            },
          };
        },
      },
    } as unknown as WorkspaceClient;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(
        request.url,
        "https://example.cloud.databricks.com/ai-gateway/routing/v1/routes:select",
      );
      routeCalls += 1;
      return Response.json({
        route_selection: [
          { route_option: { model: "system.ai.databricks-gpt-6-1-sol", harness: "codex" } },
        ],
      });
    };

    try {
      const requestContext = new RequestContext();
      const overrides = {
        modelId: "smart-router",
        smartRouterInput: { messages: [{ role: "user", content: "Explain the space" }] },
        workspaceClient: client,
      } as const;
      await buildModel({}, requestContext, overrides);
      await buildModel({}, requestContext, overrides);

      assert.equal(routeCalls, 1);
      assert.equal(catalogueCalls, 1);
      const route = requestContext.get(MASTRA_MODEL_ROUTE_KEY) as MastraModelRoute;
      assert.equal(route.model, "databricks-gpt-6-1-sol");
      assert.equal(route.selection, "smart-router");
      assert.equal(route.costPerMillionTokens, 3.5);
      assert.equal(route.smartRouter?.routeModel, "system.ai.databricks-gpt-6-1-sol");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("keeps internal model classes independent from the request model override", async () => {
    const previousEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
    process.env.DATABRICKS_SERVING_ENDPOINT_NAME = "smart-router";
    const client = {
      config: {
        getHost: () => Promise.resolve(new URL("https://example.cloud.databricks.com")),
        authenticate: (headers: Headers) => {
          headers.set("authorization", "Bearer test");
          return Promise.resolve();
        },
      },
      servingEndpoints: {
        async *list() {
          yield {
            name: "databricks-gpt-6-1-sol",
            task: "llm/v1/chat",
          };
          yield {
            name: "databricks-gpt-5-nano",
            task: "llm/v1/chat",
          };
        },
      },
    } as unknown as WorkspaceClient;
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_MODEL_OVERRIDE_KEY, "smart-router");
    requestContext.set(MASTRA_SMART_ROUTER_INPUT_KEY, {
      messages: [{ role: "user", content: "Use the primary router only for this answer" }],
    });

    try {
      const model = await buildModel({}, requestContext, {
        modelClass: ModelClass.ChatFast,
        workspaceClient: client,
      });

      assert.equal(model.modelId, "databricks-gpt-5-nano");
    } finally {
      if (previousEndpoint === undefined) delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
      else process.env.DATABRICKS_SERVING_ENDPOINT_NAME = previousEndpoint;
    }
  });

  it("never sends the virtual Smart Router id to Model Serving", async () => {
    const client = {
      config: {
        getHost: () => Promise.resolve(new URL("https://example.cloud.databricks.com")),
        authenticate: (headers: Headers) => {
          headers.set("authorization", "Bearer test");
          return Promise.resolve();
        },
      },
    } as unknown as WorkspaceClient;

    await assert.rejects(
      buildModel({}, undefined, {
        modelId: "smart-router",
        workspaceClient: client,
      }),
      /Smart Router requires task input/,
    );
  });

  it("reuses the credential-scoped catalogue for internal model classes", async () => {
    let catalogueCalls = 0;
    const identity = `user-${crypto.randomUUID()}`;
    const host = new URL(`https://${crypto.randomUUID()}.cloud.databricks.com`);
    const client = {
      config: {
        getHost: () => Promise.resolve(host),
        authenticate: (headers: Headers) => {
          headers.set("authorization", "Bearer test");
          return Promise.resolve();
        },
      },
      servingEndpoints: {
        async *list() {
          catalogueCalls += 1;
          yield {
            name: "databricks-gpt-5-nano",
            task: "llm/v1/chat",
          };
        },
      },
    } as unknown as WorkspaceClient;
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_USER_KEY, {
      id: identity,
      executionContext: {
        client,
        isUserContext: true,
        userId: identity,
      },
    });

    await buildModel({}, requestContext, { modelClass: ModelClass.ChatFast });
    await buildModel({}, requestContext, { modelClass: ModelClass.ChatFast });

    assert.equal(catalogueCalls, 1);
  });
});
