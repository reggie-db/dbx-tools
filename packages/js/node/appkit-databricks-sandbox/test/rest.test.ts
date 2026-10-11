import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";
import { DatabricksSandboxClient, isSandboxUnavailable } from "../src/rest.ts";

describe("DatabricksSandboxClient", () => {
  it("lists existing sandboxes through REST with workspace routing and pagination", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      { sandboxes: [{ sandboxId: "one", status: "RUNNING" }], nextPageToken: "next" },
      { sandboxes: [{ sandboxId: "two", status: "STOPPED" }] },
    ];
    const client = {
      config: { workspaceId: "123", host: "https://example.cloud.databricks.com" },
      apiClient: {
        request: async (request: Record<string, unknown>) => {
          requests.push(request);
          return responses.shift();
        },
      },
    } as unknown as WorkspaceClient;

    const sandboxes = await new DatabricksSandboxClient(client).list();

    assert.deepEqual(
      sandboxes.map(({ sandboxId }) => sandboxId),
      ["one", "two"],
    );
    assert.equal(requests.length, 2);
    assert.equal((requests[0]?.headers as Headers).get("X-Databricks-Org-Id"), "123");
    assert.deepEqual(requests[0]?.query, { page_size: "100" });
    assert.deepEqual(requests[1]?.query, { page_size: "100", page_token: "next" });
    assert.ok(requests.every((request) => request.method === "GET"));
  });

  it("classifies unavailable feature responses without hiding auth failures", () => {
    assert.equal(isSandboxUnavailable({ status: 503 }), true);
    assert.equal(isSandboxUnavailable({ response: { status: 404 } }), true);
    assert.equal(isSandboxUnavailable(new Error("Sandbox is not available in your region")), true);
    assert.equal(isSandboxUnavailable({ status: 401 }), false);
  });
});
