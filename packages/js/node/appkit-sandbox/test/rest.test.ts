import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";
import { DatabricksSandboxClient, isSandboxUnavailable } from "../src/rest.ts";

describe("DatabricksSandboxClient", () => {
  it("keeps ownership scope stable when the SDK lazily resolves its host", () => {
    const previousId = process.env.DATABRICKS_WORKSPACE_ID;
    const previousHost = process.env.DATABRICKS_HOST;
    delete process.env.DATABRICKS_WORKSPACE_ID;
    delete process.env.DATABRICKS_HOST;
    try {
      const config = { host: "fevm.example.cloud.databricks.com" };
      const api = new DatabricksSandboxClient({ config } as unknown as WorkspaceClient);

      config.host = "https://different.example.cloud.databricks.com";

      assert.equal(api.workspaceScope(), "https://fevm.example.cloud.databricks.com");
    } finally {
      if (previousId === undefined) delete process.env.DATABRICKS_WORKSPACE_ID;
      else process.env.DATABRICKS_WORKSPACE_ID = previousId;
      if (previousHost === undefined) delete process.env.DATABRICKS_HOST;
      else process.env.DATABRICKS_HOST = previousHost;
    }
  });

  it("uses the process workspace id so OBO and service-principal clients share Lakebase ownership", () => {
    const previousId = process.env.DATABRICKS_WORKSPACE_ID;
    process.env.DATABRICKS_WORKSPACE_ID = "shared-workspace";
    try {
      const obo = new DatabricksSandboxClient({
        config: { workspaceId: "obo-only", host: "https://obo.example.cloud.databricks.com" },
      } as unknown as WorkspaceClient);
      const servicePrincipal = new DatabricksSandboxClient({
        config: { host: "https://sp.example.cloud.databricks.com" },
      } as unknown as WorkspaceClient);
      assert.equal(obo.workspaceScope(), "shared-workspace");
      assert.equal(servicePrincipal.workspaceScope(), "shared-workspace");
    } finally {
      if (previousId === undefined) delete process.env.DATABRICKS_WORKSPACE_ID;
      else process.env.DATABRICKS_WORKSPACE_ID = previousId;
    }
  });

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

  it("creates and deletes sandboxes through the native Lakebox API", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = {
      config: { workspaceId: "123", host: "https://example.cloud.databricks.com" },
      apiClient: {
        request: async (request: Record<string, unknown>) => {
          requests.push(request);
          return request.method === "POST"
            ? { sandboxId: "created", status: "Running", gatewayHost: "gateway.example" }
            : {};
        },
      },
    } as unknown as WorkspaceClient;
    const api = new DatabricksSandboxClient(client);

    const created = await api.create("project sandbox");
    await api.delete(created.sandboxId);

    assert.equal(created.sandboxId, "created");
    assert.deepEqual(requests[0]?.payload, { sandbox: { name: "project sandbox" } });
    assert.equal(requests[0]?.path, "/api/2.0/lakebox/sandboxes");
    assert.equal(requests[0]?.method, "POST");
    assert.equal(requests[1]?.path, "/api/2.0/lakebox/sandboxes/created");
    assert.equal(requests[1]?.method, "DELETE");
  });

  it("classifies unavailable feature responses without hiding auth failures", () => {
    assert.equal(isSandboxUnavailable({ status: 503 }), true);
    assert.equal(isSandboxUnavailable({ response: { status: 404 } }), true);
    assert.equal(isSandboxUnavailable(new Error("Sandbox is not available in your region")), true);
    assert.equal(isSandboxUnavailable({ status: 401 }), false);
  });
});
