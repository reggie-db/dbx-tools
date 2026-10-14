import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";

import { DatabricksModelRegistry } from "../src/registry.ts";

describe("DatabricksModelRegistry system-model preference", () => {
  it("prefers system endpoints only for non-exact resolution when enabled", async () => {
    const client = workspaceClient();
    const defaultRegistry = new DatabricksModelRegistry({ client });
    const preferredRegistry = new DatabricksModelRegistry({ client, preferSystemModels: true });

    assert.equal((await defaultRegistry.resolve("gpt-5-6-sol"))?.id, "databricks-gpt-5-6-sol");
    assert.equal((await preferredRegistry.resolve("gpt-5-6-sol"))?.id, "system.ai.gpt-5-6-sol");
    assert.equal(
      (await preferredRegistry.resolve("databricks-gpt-5-6-sol"))?.id,
      "databricks-gpt-5-6-sol",
    );
    assert.equal(
      (await defaultRegistry.resolve("system.ai.gpt-5-6-sol"))?.id,
      "system.ai.gpt-5-6-sol",
    );
  });
});

function workspaceClient(): WorkspaceClient {
  const endpoints = [endpoint("databricks-gpt-5-6-sol"), endpoint("system.ai.gpt-5-6-sol")];
  return {
    config: {
      async getHost() {
        return new URL("https://workspace.example.com");
      },
    },
    servingEndpoints: {
      async *list() {
        yield* endpoints;
      },
    },
  } as unknown as WorkspaceClient;
}

function endpoint(name: string) {
  return {
    name,
    task: "llm/v1/chat",
    state: { ready: "READY" },
    config: {
      served_entities: [
        {
          entity_name: name,
          foundation_model: { name: "system.ai.gpt-5-6-sol" },
        },
      ],
    },
  };
}
