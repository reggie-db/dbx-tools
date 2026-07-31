import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toCreateIndexOptions } from "../src/index-tools.ts";
import { createIndexTool, syncIndexTool } from "../src/tool.ts";

describe("toCreateIndexOptions", () => {
  it("spreads only supplied fields so client defaults still apply", () => {
    const options = toCreateIndexOptions({ name: "main.docs.index" });
    assert.deepEqual(options, {});
  });

  it("maps a full Delta Sync request onto client options", () => {
    const signal = new AbortController().signal;
    const options = toCreateIndexOptions(
      {
        name: "main.docs.index",
        sourceTable: "main.docs.source",
        primaryKey: "doc_id",
        embeddingSourceColumn: "body",
        embeddingModel: "databricks-gte-large-en",
        endpoint: "vs-endpoint",
        pipelineType: "CONTINUOUS",
        columnsToSync: ["title", "url"],
      },
      signal,
    );
    assert.equal(options.sourceTable, "main.docs.source");
    assert.equal(options.primaryKey, "doc_id");
    assert.equal(options.embeddingSourceColumn, "body");
    assert.equal(options.embeddingModel, "databricks-gte-large-en");
    assert.equal(options.endpoint, "vs-endpoint");
    assert.equal(options.pipelineType, "CONTINUOUS");
    assert.deepEqual(options.columnsToSync, ["title", "url"]);
    assert.equal(options.signal, signal);
  });

  it("maps a direct-access request's embedding dimension", () => {
    const options = toCreateIndexOptions({
      name: "main.docs.direct",
      embeddingDimension: 1024,
    });
    assert.equal(options.embeddingDimension, 1024);
    assert.equal(options.sourceTable, undefined);
  });

  it("keeps an embedding dimension of 0 (explicitly supplied)", () => {
    const options = toCreateIndexOptions({ name: "x", embeddingDimension: 0 });
    assert.equal(options.embeddingDimension, 0);
  });
});

describe("write tool factories", () => {
  it("create_index / sync_index expose default ids and can be renamed", () => {
    assert.equal(createIndexTool().id, "create_index");
    assert.equal(syncIndexTool().id, "sync_index");
    assert.equal(createIndexTool({ id: "provision" }).id, "provision");
    assert.equal(syncIndexTool({ id: "refresh" }).id, "refresh");
  });
});
