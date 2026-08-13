import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { search as sharedSearch } from "@dbx-tools/shared-search";
import { defaultAlias, resolveSearchConfig, resolveIndexName } from "../src/config.ts";
import { toDocumentArray } from "../src/query.ts";

describe("search query translation", () => {
  it("maps modes onto AppKit AI Search query types", () => {
    assert.equal(sharedSearch.toAiSearchQueryType("hybrid"), "hybrid");
    assert.equal(sharedSearch.toAiSearchQueryType("vector"), "ann");
    assert.equal(sharedSearch.toAiSearchQueryType("keyword"), "full_text");
  });

  it("coerces a document string / object / array into an array of records", () => {
    assert.deepEqual(toDocumentArray('{"id":"1"}'), [{ id: "1" }]);
    assert.deepEqual(toDocumentArray([{ id: "1" }, { id: "2" }]), [{ id: "1" }, { id: "2" }]);
    assert.throws(() => toDocumentArray("not json"));
  });
});

describe("search config", () => {
  it("derives an alias from the last dotted segment", () => {
    assert.equal(defaultAlias("main.support.docs"), "docs");
  });

  it("unions the default index into the known set and resolves it by alias", () => {
    const config = resolveSearchConfig({ index: "main.support.docs" });
    assert.equal(config.defaultIndex, "main.support.docs");
    assert.equal(config.indexes[0].alias, "docs");
    assert.equal(resolveIndexName(config, "docs"), "main.support.docs");
    assert.equal(resolveIndexName(config, undefined), "main.support.docs");
  });

  it("accepts an unregistered fully-qualified index name", () => {
    const config = resolveSearchConfig({ index: "main.support.docs" });
    assert.equal(resolveIndexName(config, "main.other.things"), "main.other.things");
  });

  it("de-duplicates aliases across indexes", () => {
    const config = resolveSearchConfig({
      indexes: ["a.b.docs", "x.y.docs"],
    });
    const aliases = config.indexes.map((i) => i.alias);
    assert.equal(new Set(aliases).size, aliases.length);
  });

  it("defaults mode, page size, and base path", () => {
    const config = resolveSearchConfig({});
    assert.equal(config.mode, "hybrid");
    assert.equal(config.pageSize, 10);
    assert.equal(config.basePath, "/api/search");
    assert.equal(config.allowWrite, false);
  });
});
