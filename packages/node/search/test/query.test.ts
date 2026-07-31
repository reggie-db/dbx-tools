import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultAlias, resolveSearchConfig, resolveIndexName } from "../src/config.ts";
import {
  compileFilter,
  toDocumentArray,
  toHits,
  toQueryType,
  toRequestColumns,
} from "../src/query.ts";

describe("search query translation", () => {
  it("maps modes onto the serving query_type", () => {
    assert.equal(toQueryType("hybrid"), "HYBRID");
    assert.equal(toQueryType("vector"), "ANN");
    assert.equal(toQueryType("keyword"), "ANN");
  });

  it("compiles a scalar filter to an equality and omits an empty filter", () => {
    assert.equal(compileFilter(undefined), undefined);
    assert.equal(compileFilter({}), undefined);
    assert.equal(
      compileFilter({ locale: "en", published: true }),
      '{"locale":"en","published":true}',
    );
  });

  it("expands an operator map into column-operator keys", () => {
    assert.equal(compileFilter({ price: { ">=": 10, "<": 20 } }), '{"price >=":10,"price <":20}');
  });

  it("unpacks a columnar response into { id, score, fields } hits", () => {
    const hits = toHits(
      {
        manifest: { columns: [{ name: "id" }, { name: "title" }, { name: "__db_score" }] },
        result: {
          data_array: [
            ["42", "Reset", "0.87"],
            ["7", "Login", "0.5"],
          ],
        },
      },
      "id",
    );
    assert.equal(hits.length, 2);
    assert.deepEqual(hits[0], { id: "42", score: 0.87, fields: { id: "42", title: "Reset" } });
    assert.equal(hits[1].id, "7");
    assert.ok(!("__db_score" in hits[1].fields));
  });

  it("always requests the primary key so a hit has an id", () => {
    assert.deepEqual(toRequestColumns(["title"], undefined, "id"), ["title", "id"]);
    assert.deepEqual(toRequestColumns(undefined, ["a", "b"], "pk"), ["a", "b", "pk"]);
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
