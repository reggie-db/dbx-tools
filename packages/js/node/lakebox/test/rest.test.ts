import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isLakeboxUnavailable, LakeboxApiError, LakeboxClient } from "../src/rest.ts";

const originalFetch = globalThis.fetch;

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: unknown;
}

function recordFetch(responses: unknown[], status = 200): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    return new Response(JSON.stringify(responses.shift() ?? {}), { status });
  }) as typeof fetch;
  return requests;
}

const auth = {
  host: "https://example.cloud.databricks.com/",
  workspaceId: "123",
  authenticate: async (headers: Headers) => headers.set("Authorization", "Bearer token"),
};

describe("LakeboxClient", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("lists Lakeboxes with workspace routing and pagination", async () => {
    const requests = recordFetch([
      { sandboxes: [{ sandboxId: "one", status: "Running" }], nextPageToken: "next" },
      { sandboxes: [{ sandboxId: "two", status: "Stopped" }] },
    ]);

    const entries = await new LakeboxClient(auth).list();

    assert.deepEqual(
      entries.map(({ sandboxId }) => sandboxId),
      ["one", "two"],
    );
    assert.equal(
      requests[0]?.url,
      "https://example.cloud.databricks.com/api/2.0/lakebox/sandboxes?page_size=100",
    );
    assert.match(requests[1]?.url ?? "", /page_token=next/);
    assert.equal(requests[0]?.headers.get("X-Databricks-Org-Id"), "123");
    assert.equal(requests[0]?.headers.get("Authorization"), "Bearer token");
  });

  it("creates, configures idle timeout, and deletes through the native API", async () => {
    const requests = recordFetch([
      { sandboxId: "created", status: "Running" },
      { sandboxId: "created", status: "Running", idleTimeout: "900s" },
      {},
    ]);
    const api = new LakeboxClient(auth);

    const created = await api.create();
    await api.setIdleTimeout(created.sandboxId, 900);
    await api.delete(created.sandboxId);

    assert.deepEqual(requests[0]?.body, { sandbox: {} });
    assert.equal(requests[1]?.method, "PATCH");
    assert.deepEqual(requests[1]?.body, { sandbox_id: "created", idle_timeout: "900s" });
    assert.equal(requests[2]?.method, "DELETE");
    assert.match(requests[2]?.url ?? "", /\/sandboxes\/created$/);
  });

  it("raises typed errors and classifies unavailable workspaces", async () => {
    recordFetch([{ message: "not here", error_code: "NOT_FOUND" }], 404);

    await assert.rejects(new LakeboxClient(auth).list(), (error) => {
      assert.ok(error instanceof LakeboxApiError);
      assert.equal(error.status, 404);
      assert.equal(error.errorCode, "NOT_FOUND");
      assert.equal(isLakeboxUnavailable(error), true);
      return true;
    });
    assert.equal(isLakeboxUnavailable(new LakeboxApiError("denied", 401)), false);
    assert.equal(isLakeboxUnavailable(new Error("other")), false);
  });

  it("scopes keys to the workspace identifier", async () => {
    const previous = process.env.DATABRICKS_WORKSPACE_ID;
    delete process.env.DATABRICKS_WORKSPACE_ID;
    try {
      assert.equal(await new LakeboxClient(auth).workspaceScope(), "123");
      assert.equal(
        await new LakeboxClient({ ...auth, workspaceId: undefined }).workspaceScope(),
        "https://example.cloud.databricks.com",
      );
    } finally {
      if (previous !== undefined) process.env.DATABRICKS_WORKSPACE_ID = previous;
    }
  });
});
