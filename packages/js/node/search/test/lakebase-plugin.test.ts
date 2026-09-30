import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
} from "@databricks/appkit/testing";

import { LakebaseAiSearchPlugin, type LakebaseAiSearchConfig } from "../src/lakebase-plugin.ts";

function plugin(config: LakebaseAiSearchConfig) {
  const instance = new LakebaseAiSearchPlugin(config);
  const writes: unknown[][] = [];
  Object.assign(instance, {
    backend: {
      async search() {
        return {
          hits: [
            {
              id: "1",
              score: 1,
              fields: { title: "Visible", internal: "secret" },
            },
          ],
          count: 1,
        };
      },
      async addDocuments(_index: string, documents: unknown[]) {
        writes.push(documents);
        return { index: "docs", count: documents.length };
      },
    },
  });
  return { instance, writes };
}

function responseJson(response: ReturnType<typeof createMockResponse>): unknown {
  return response.json.mock.calls[0]?.[0];
}

describe("Lakebase AI Search HTTP policy", () => {
  it("cannot widen configured columns over HTTP", async () => {
    const { instance } = plugin({
      indexes: { docs: { columns: ["id", "title"] } },
    });
    const { router, getHandler } = createMockRouter();
    instance.injectRoutes(router);
    const response = createMockResponse();

    await getHandler("post", "/:alias/query")(
      createMockRequest({
        params: { alias: "docs" },
        body: { queryText: "visible", columns: ["id", "title", "internal"] },
      }),
      response,
    );

    assert.deepEqual(responseJson(response), {
      results: [{ score: 1, data: { id: "1", title: "Visible" } }],
      totalCount: 1,
      queryTimeMs: (responseJson(response) as { queryTimeMs: number }).queryTimeMs,
      queryType: "full_text",
      nextPageToken: null,
    });
  });

  it("keeps trusted programmatic projection overrides", async () => {
    const { instance } = plugin({
      indexes: { docs: { columns: ["id", "title"] } },
    });

    const result = await instance.query("docs", {
      queryText: "visible",
      columns: ["id", "internal"],
    });

    assert.deepEqual(result.results[0]?.data, { id: "1", internal: "secret" });
  });

  it("enters OBO scope for query and write routes", async () => {
    const { instance, writes } = plugin({
      allowWrite: true,
      indexes: { docs: { auth: "on-behalf-of-user" } },
    });
    const requests: unknown[] = [];
    Object.assign(instance, {
      asUser(request: unknown) {
        requests.push(request);
        return instance;
      },
    });
    const { router, getHandler } = createMockRouter();
    instance.injectRoutes(router);
    const request = createMockRequest({
      obo: { userId: "user-a" },
      params: { alias: "docs" },
      body: { queryText: "visible" },
    });

    await getHandler("post", "/:alias/query")(request, createMockResponse());
    request.body = { documents: [{ id: "1", text: "private" }] };
    await getHandler("post", "/:alias/documents")(request, createMockResponse());

    assert.equal(requests.length, 2);
    assert.deepEqual(writes, [[{ id: "1", text: "private" }]]);
  });

  it("rejects an unsupported auth mode before resolving Lakebase", async () => {
    const instance = new LakebaseAiSearchPlugin({
      indexes: { docs: { auth: "invalid" } },
    } as unknown as LakebaseAiSearchConfig);

    await assert.rejects(instance.setup(), /Unknown AI Search auth mode/);
  });
});
