import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SearchReadBackend } from "../src/client.ts";
import { SearchPlugin } from "../src/plugin.ts";
import { setSearchReadBackend, type SearchRuntime } from "../src/runtime.ts";

interface BackendCall {
  owner: string;
  index: string;
}

function runtimeOf(plugin: SearchPlugin): SearchRuntime {
  return (plugin as unknown as { runtime: SearchRuntime }).runtime;
}

function backend(owner: string, calls: BackendCall[]): SearchReadBackend {
  return {
    supportsLifecycle: owner === "vector",
    async search(index, query) {
      calls.push({ owner, index });
      return {
        query,
        index,
        hits: [{ id: owner, score: 1, fields: { owner } }],
        count: 1,
      };
    },
  };
}

describe("search plugin runtime ownership", () => {
  it("isolates configs and backends across plugin shutdown", async () => {
    const calls: BackendCall[] = [];
    const first = new SearchPlugin({ index: "main.first.docs" });
    const second = new SearchPlugin({ index: "main.second.docs" });
    setSearchReadBackend(runtimeOf(first), backend("vector", calls));
    setSearchReadBackend(runtimeOf(second), backend("lakebase", calls));

    const firstResult = await first.exports().search({ query: "first" });
    const secondResult = await second.exports().search({ query: "second" });
    assert.equal(firstResult.index, "main.first.docs");
    assert.equal(firstResult.hits[0]?.fields.owner, "vector");
    assert.equal(secondResult.index, "main.second.docs");
    assert.equal(secondResult.hits[0]?.fields.owner, "lakebase");

    first.shutdown();
    const afterShutdown = await second.exports().search({ query: "still active" });
    assert.equal(afterShutdown.hits[0]?.fields.owner, "lakebase");
    assert.deepEqual(calls, [
      { owner: "vector", index: "main.first.docs" },
      { owner: "lakebase", index: "main.second.docs" },
      { owner: "lakebase", index: "main.second.docs" },
    ]);
  });
});
