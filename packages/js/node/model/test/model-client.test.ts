import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AuthClient } from "@dbx-tools/auth";

import {
  createModelClientWithDatabricksClient,
  DEFAULT_MODEL_CLIENT_CACHE_TTL_MS,
} from "../src/model-client.ts";

const HOST = "https://workspace.example.com";

describe("ModelClient", () => {
  it("coalesces cached discovery and refreshes explicitly", async () => {
    let calls = 0;
    const client = createModelClientWithDatabricksClient(
      fakeClient(async () => {
        calls += 1;
        return response("databricks-gpt-5-4");
      }),
    );
    const [left, right] = await Promise.all([client.listModels(), client.listModels()]);
    assert.equal(calls, 1);
    assert.equal(left[0]?.name, "databricks-gpt-5-4");
    assert.equal(right[0]?.name, "databricks-gpt-5-4");
    await client.listModels(true);
    assert.equal(calls, 2);
    assert.equal(client.status().cacheTtlMs, DEFAULT_MODEL_CLIENT_CACHE_TTL_MS);
  });

  it("isolates catalogues by principal", async () => {
    let leftCalls = 0;
    let rightCalls = 0;
    const left = createModelClientWithDatabricksClient(
      fakeClient(async () => {
        leftCalls += 1;
        return response("left-private");
      }, "left"),
    );
    const right = createModelClientWithDatabricksClient(
      fakeClient(async () => {
        rightCalls += 1;
        return response("right-private");
      }, "right"),
    );
    assert.equal((await left.listModels())[0]?.name, "left-private");
    assert.equal((await right.listModels())[0]?.name, "right-private");
    assert.equal(leftCalls, 1);
    assert.equal(rightCalls, 1);
  });

  it("resolves live models and returns authenticated routes", async () => {
    const client = createModelClientWithDatabricksClient(
      fakeClient(async () => ({
        endpoints: [
          endpoint("databricks-gpt-5-4"),
          endpoint("databricks-bge-large-en", "llm/v1/embeddings"),
        ],
      })),
    );
    const route = await client.route({ explicit: "gpt", protocol: "responses" });
    assert.equal(route.protocol, "responses");
    assert.equal(route.url, `${HOST}/serving-endpoints/responses`);
    assert.deepEqual(route.headers, {
      authorization: "Bearer token",
      "x-databricks-workspace-id": "123",
    });
    assert.equal(route.metadata.capabilities.responses, true);
    assert.equal(
      (await client.route({ explicit: "bge", protocol: "embeddings" })).url,
      `${HOST}/serving-endpoints/databricks-bge-large-en/invocations`,
    );
  });

  it("fails fast on invalid responses and cache TTLs", async () => {
    assert.throws(() =>
      createModelClientWithDatabricksClient(
        fakeClient(async () => ({})),
        0,
      ),
    );
    await assert.rejects(
      createModelClientWithDatabricksClient(fakeClient(async () => ({}), "invalid")).listModels(),
      /missing an endpoints array/,
    );
  });
});

function response(name: string): unknown {
  return { endpoints: [endpoint(name)] };
}

function endpoint(name: string, task = "llm/v1/chat") {
  return {
    name,
    task,
    state: { ready: "READY" },
    config: {
      served_entities: [{ entity_name: name, foundation_model: { name: `system.ai.${name}` } }],
    },
  };
}

function fakeClient(load: () => Promise<unknown>, principal = "principal") {
  const auth = {
    profile: "DEFAULT",
    host: HOST,
    workspaceId: "123",
    target: "workspace",
    authType: "pat",
    principal,
    headers: async () => ({
      authorization: "Bearer token",
      "x-databricks-workspace-id": "123",
    }),
  } as unknown as AuthClient;
  return {
    auth,
    host: () => HOST,
    principal: () => principal,
    workspaceId: () => "123",
    request: load,
  };
}
