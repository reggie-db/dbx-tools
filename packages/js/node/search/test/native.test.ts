/**
 * Native AppKit AI Search adapter tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSearchClient } from "../src/client.ts";
import { resolveSearchConfig } from "../src/config.ts";
import { lakebaseAiSearch } from "../src/lakebase-plugin.ts";
import { nativeAiSearchBackend, type AiSearchProvider } from "../src/native.ts";

describe("native AI Search adapter", () => {
  it("registers the Lakebase provider under AppKit's aiSearch name", () => {
    assert.equal(lakebaseAiSearch({ indexes: {} }).name, "aiSearch");
  });

  it("delegates query execution and maps AppKit results", async () => {
    let alias: string | undefined;
    let request: Parameters<AiSearchProvider["query"]>[1] | undefined;
    const provider: AiSearchProvider = {
      async query(nextAlias, nextRequest) {
        alias = nextAlias;
        request = nextRequest;
        return {
          results: [{ score: 0.8, data: { doc_id: "42", title: "Result" } }],
          totalCount: 1,
          queryTimeMs: 2,
          queryType: "full_text",
          nextPageToken: null,
        };
      },
    };
    const config = resolveSearchConfig({
      index: "main.docs.search",
      indexes: [
        {
          name: "main.docs.search",
          alias: "docs",
          primaryKey: "doc_id",
          columns: ["doc_id", "title"],
        },
      ],
    });

    const result = await nativeAiSearchBackend(provider, config).search(
      "main.docs.search",
      "invoice",
      { mode: "keyword", limit: 3 },
    );

    assert.equal(alias, "docs");
    assert.deepEqual(request, {
      queryText: "invoice",
      numResults: 3,
      queryType: "full_text",
    });
    assert.deepEqual(result, {
      query: "invoice",
      index: "main.docs.search",
      hits: [
        {
          id: "42",
          score: 0.8,
          fields: { doc_id: "42", title: "Result" },
        },
      ],
      count: 1,
    });
  });

  it("leaves query type unset so the provider default applies", async () => {
    let request: Parameters<AiSearchProvider["query"]>[1] | undefined;
    const provider: AiSearchProvider = {
      async query(_alias, nextRequest) {
        request = nextRequest;
        return {
          results: [],
          totalCount: 0,
          queryTimeMs: 1,
          queryType: "full_text",
          nextPageToken: null,
        };
      },
    };
    const config = resolveSearchConfig({
      index: "docs",
      indexes: [{ name: "docs", alias: "docs" }],
    });

    await nativeAiSearchBackend(provider, config).search("docs", "lakebase");

    assert.deepEqual(request, { queryText: "lakebase", numResults: 10 });
  });

  it("forwards extension options through SearchClient to AppKit", async () => {
    let request: Parameters<AiSearchProvider["query"]>[1] | undefined;
    const provider: AiSearchProvider = {
      async query(_alias, nextRequest) {
        request = nextRequest;
        return {
          results: [],
          totalCount: 0,
          queryTimeMs: 1,
          queryType: "hybrid",
          nextPageToken: null,
        };
      },
    };
    const config = resolveSearchConfig({
      index: "main.docs.search",
      indexes: [{ name: "main.docs.search", alias: "docs" }],
    });
    const backend = nativeAiSearchBackend(provider, config);
    assert.equal(backend.supportsLifecycle, true);
    const client = createSearchClient(config, undefined, backend);

    await client.search("invoice", {
      mode: "hybrid",
      columns: ["id", "title"],
      filter: { locale: "en", category: ["billing", "support"] },
      limit: 4,
    });

    assert.deepEqual(request, {
      queryText: "invoice",
      queryType: "hybrid",
      columns: ["id", "title"],
      filters: { locale: "en", category: ["billing", "support"] },
      numResults: 4,
    });
  });

  it("allows Lakebase document writes but rejects Vector lifecycle calls", async () => {
    const provider: AiSearchProvider = {
      providerKind: "lakebase",
      async query() {
        return {
          results: [],
          totalCount: 0,
          queryTimeMs: 1,
          queryType: "full_text",
          nextPageToken: null,
        };
      },
      async addDocuments(alias, documents) {
        return { index: alias, count: documents.length };
      },
    };
    const config = resolveSearchConfig({
      index: "docs",
      indexes: [{ name: "docs", alias: "docs" }],
    });
    const backend = nativeAiSearchBackend(provider, config);
    const client = createSearchClient(config, undefined, backend);

    assert.equal(backend.supportsLifecycle, false);
    assert.deepEqual(await client.addDocuments("docs", [{ id: "1", text: "one" }]), {
      index: "docs",
      count: 1,
    });
    await assert.rejects(client.createIndex("docs"), /does not support createIndex/);
  });
});
