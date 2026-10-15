import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGenieSpace, genieSampleQuestions, getGenieSpace } from "../src/space.ts";

/**
 * Minimal `WorkspaceClient` stand-in: records the query of every raw
 * `apiClient.request` so a test can assert whether the serialized retry ran.
 */
function fakeWorkspaceClient(handler: (query: Record<string, unknown>) => unknown) {
  const queries: Record<string, unknown>[] = [];
  const client = {
    apiClient: {
      request: async (request: { query?: Record<string, unknown> }) => {
        const query = request.query ?? {};
        queries.push(query);
        return handler(query);
      },
    },
  };
  return { client: client as never, queries };
}

function permissionDenied(): Error {
  return Object.assign(new Error('You need "Can Edit" permission to perform this action'), {
    errorCode: "PERMISSION_DENIED",
    statusCode: 403,
  });
}

describe("getGenieSpace", () => {
  it("retries without the serialized flag when the blob is forbidden", async () => {
    const { client, queries } = fakeWorkspaceClient((query) => {
      if (query.include_serialized_space) throw permissionDenied();
      return { space_id: "space-1", title: "Sales" };
    });

    const space = await getGenieSpace("space-1", { workspaceClient: client });

    assert.deepEqual(
      queries.map((query) => query.include_serialized_space),
      [true, undefined],
    );
    assert.equal(space.title, "Sales");
    assert.deepEqual(genieSampleQuestions(space), []);
  });

  it("rethrows when the unserialized retry also fails", async () => {
    const { client, queries } = fakeWorkspaceClient(() => {
      throw permissionDenied();
    });

    await assert.rejects(getGenieSpace("space-1", { workspaceClient: client }), /Can Edit/);
    assert.equal(queries.length, 2);
  });

  it("rethrows a non-permission failure without retrying", async () => {
    const { client, queries } = fakeWorkspaceClient(() => {
      throw new Error("The operation was aborted.");
    });

    await assert.rejects(getGenieSpace("space-1", { workspaceClient: client }), /aborted/);
    assert.equal(queries.length, 1);
  });

  it("does not retry when the caller opted out of the serialized blob", async () => {
    const { client, queries } = fakeWorkspaceClient(() => {
      throw permissionDenied();
    });

    await assert.rejects(
      getGenieSpace("space-1", { workspaceClient: client, serialized: false }),
      /Can Edit/,
    );
    assert.equal(queries.length, 1);
  });
});

describe("createGenieSpace", () => {
  it("posts the validated serialized definition through the supplied identity", async () => {
    const requests: unknown[] = [];
    const client = {
      apiClient: {
        request: async (request: unknown) => {
          requests.push(request);
          return {
            space_id: "space-1",
            title: "Generated sales",
            warehouse_id: "warehouse-1",
          };
        },
      },
    };
    const created = await createGenieSpace(
      {
        warehouse_id: "warehouse-1",
        title: "Generated sales",
        serialized_space: JSON.stringify({ version: 1, data_sources: { tables: [] } }),
      },
      { workspaceClient: client as never },
    );
    assert.equal(created.space_id, "space-1");
    assert.deepEqual(requests, [
      {
        path: "/api/2.0/genie/spaces",
        method: "POST",
        payload: {
          warehouse_id: "warehouse-1",
          title: "Generated sales",
          serialized_space: '{"version":1,"data_sources":{"tables":[]}}',
        },
        headers: new Headers(),
        raw: false,
      },
    ]);
  });
});
