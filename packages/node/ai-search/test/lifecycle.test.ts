import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SearchClient } from "../src/client.ts";
import { DEFAULT_MODE, DEFAULT_PAGE_SIZE, DEFAULT_TIMEOUT_MS } from "../src/config.ts";

// A minimal fake of the pieces of the SDK workspace client the lifecycle
// helpers touch, recording the requests they build so we can assert the
// translation (index type, embedding column, endpoint) without a workspace.
function fakeClient(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ op: string; request: unknown }> = [];
  const client = {
    config: { getHost: async () => "https://example.databricks.com" },
    vectorSearchIndexes: {
      createIndex: async (request: unknown) => {
        calls.push({ op: "createIndex", request });
        // After a create the index now exists, so the post-create readback works.
        overrides.missing = false;
        return {};
      },
      getIndex: async (request: { index_name: string }) => {
        calls.push({ op: "getIndex", request });
        if (overrides.missing) throw new Error("RESOURCE_DOES_NOT_EXIST");
        return {
          name: request.index_name,
          endpoint_name: "vs-endpoint",
          primary_key: "id",
          status: { ready: true, indexed_row_count: 3 },
          delta_sync_index_spec: { embedding_source_columns: [{ name: "text" }] },
        };
      },
      syncIndex: async (request: unknown) => {
        calls.push({ op: "syncIndex", request });
        return {};
      },
      deleteIndex: async (request: unknown) => {
        calls.push({ op: "deleteIndex", request });
        return {};
      },
      listIndexes: async function* (request: unknown) {
        calls.push({ op: "listIndexes", request });
        yield { name: "a.b.docs" };
        yield { name: "a.b.tickets" };
      },
    },
    vectorSearchEndpoints: {
      getEndpoint: async (request: unknown) => {
        calls.push({ op: "getEndpoint", request });
        if (overrides.missingEndpoint) throw new Error("not found");
        return { name: "vs-endpoint" };
      },
      createEndpoint: async (request: unknown) => {
        calls.push({ op: "createEndpoint", request });
        return { wait: async () => undefined };
      },
    },
  };
  return { client, calls };
}

function makeClient(fake: ReturnType<typeof fakeClient>, endpoint = "vs-endpoint") {
  return new SearchClient(
    {
      indexes: [],
      pageSize: DEFAULT_PAGE_SIZE,
      mode: DEFAULT_MODE,
      basePath: "/api/ai-search",
      timeoutMs: DEFAULT_TIMEOUT_MS,
      allowWrite: false,
      endpoint,
      embeddingModel: "databricks-gte-large-en",
    },
    () => fake.client as never,
  );
}

describe("ai-search index lifecycle", () => {
  it("creates a Delta Sync index inferring key, column, and type", async () => {
    const fake = fakeClient();
    const info = await makeClient(fake).createIndex("main.docs.index", {
      sourceTable: "main.docs.source",
    });
    const create = fake.calls.find((c) => c.op === "createIndex")?.request as Record<
      string,
      unknown
    >;
    assert.equal(create.index_type, "DELTA_SYNC");
    assert.equal(create.primary_key, "id");
    const spec = create.delta_sync_index_spec as Record<string, unknown>;
    assert.equal(spec.source_table as string, "main.docs.source");
    assert.equal(spec.pipeline_type, "TRIGGERED");
    assert.equal(info.name, "main.docs.index");
  });

  it("creates a direct-access index when given a dimension and no source table", async () => {
    const fake = fakeClient();
    await makeClient(fake).createIndex("main.docs.direct", { embeddingDimension: 1024 });
    const create = fake.calls.find((c) => c.op === "createIndex")?.request as Record<
      string,
      unknown
    >;
    assert.equal(create.index_type, "DIRECT_ACCESS");
    const spec = create.direct_access_index_spec as Record<string, unknown>;
    const cols = spec.embedding_vector_columns as Array<Record<string, unknown>>;
    assert.equal(cols[0].embedding_dimension, 1024);
    assert.equal(cols[0].name, "embedding");
  });

  it("creates a MANAGED direct-access index by default (Databricks embeds a text column)", async () => {
    const fake = fakeClient();
    await makeClient(fake).createIndex("main.docs.managed", {});
    const create = fake.calls.find((c) => c.op === "createIndex")?.request as Record<
      string,
      unknown
    >;
    assert.equal(create.index_type, "DIRECT_ACCESS");
    const spec = create.direct_access_index_spec as Record<string, unknown>;
    const sources = spec.embedding_source_columns as Array<Record<string, unknown>>;
    assert.equal(sources[0].name, "text");
    assert.ok(sources[0].embedding_model_endpoint_name, "resolves an embedding model");
    const schema = JSON.parse(spec.schema_json as string) as Record<string, string>;
    assert.equal(schema.id, "string");
    assert.equal(schema.text, "string");
  });

  it("ensureIndex returns the existing index without creating", async () => {
    const fake = fakeClient();
    await makeClient(fake).ensureIndex("main.docs.index", { sourceTable: "main.docs.source" });
    assert.equal(
      fake.calls.some((c) => c.op === "createIndex"),
      false,
    );
  });

  it("ensureIndex creates when the index is missing", async () => {
    const fake = fakeClient({ missing: true });
    await makeClient(fake).ensureIndex("main.docs.index", { sourceTable: "main.docs.source" });
    assert.equal(
      fake.calls.some((c) => c.op === "createIndex"),
      true,
    );
  });

  it("sync / delete / list route through the SDK", async () => {
    const fake = fakeClient();
    const client = makeClient(fake);
    await client.syncIndex("main.docs.index");
    await client.deleteIndex("main.docs.index");
    const names = await client.listIndexes();
    assert.deepEqual(names, ["a.b.docs", "a.b.tickets"]);
    assert.ok(fake.calls.some((c) => c.op === "syncIndex"));
    assert.ok(fake.calls.some((c) => c.op === "deleteIndex"));
  });

  it("rejects a blank index reference instead of calling the API", async () => {
    // A blank reference is what an omitted `index` becomes when no default is
    // configured. Reaching the SDK it would build a URL with the name segment
    // missing and come back as a confusing ENDPOINT_NOT_FOUND, so every
    // index-scoped call must fail fast and name the real problem.
    const fake = fakeClient();
    const client = makeClient(fake);
    for (const call of [
      () => client.syncIndex(""),
      () => client.deleteIndex(""),
      () => client.getIndex(""),
      () => client.addDocuments("", [{ id: "1" }]),
      () => client.deleteDocuments("", ["1"]),
    ]) {
      await assert.rejects(call, /no index configured/);
    }
    assert.deepEqual(fake.calls, []);
  });

  it("ensureEndpoint creates only when missing", async () => {
    const present = fakeClient();
    await makeClient(present).ensureEndpoint();
    assert.equal(
      present.calls.some((c) => c.op === "createEndpoint"),
      false,
    );

    const missing = fakeClient({ missingEndpoint: true });
    await makeClient(missing).ensureEndpoint();
    assert.equal(
      missing.calls.some((c) => c.op === "createEndpoint"),
      true,
    );
  });
});
