import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { json } from "../index.ts";

describe("json.parse", () => {
  it("parses a well-formed document", () => {
    assert.deepEqual(json.parse('{"a":1}'), { a: 1 });
    assert.deepEqual(json.parse("[1,2]"), [1, 2]);
    assert.equal(json.parse('"text"'), "text");
  });

  it("returns the fallback for malformed JSON instead of throwing", () => {
    assert.equal(json.parse("{not json"), undefined);
    assert.deepEqual(json.parse("{not json", { ok: false }), { ok: false });
  });

  it("treats absent / blank / non-string input as a miss", () => {
    assert.equal(json.parse(undefined), undefined);
    assert.equal(json.parse(null), undefined);
    assert.equal(json.parse("   "), undefined);
    assert.equal(json.parse(42), undefined);
    assert.deepEqual(json.parse(undefined, []), []);
  });
});

describe("json.parseRecord", () => {
  it("returns the object for a record document", () => {
    assert.deepEqual(json.parseRecord('{"name":"pkg"}'), { name: "pkg" });
  });

  it("rejects documents that parse to a non-record", () => {
    assert.equal(json.parseRecord("[1,2]"), undefined);
    assert.equal(json.parseRecord('"text"'), undefined);
    assert.equal(json.parseRecord("null"), undefined);
    assert.equal(json.parseRecord("7"), undefined);
  });

  it("returns undefined for malformed or absent input", () => {
    assert.equal(json.parseRecord("{oops"), undefined);
    assert.equal(json.parseRecord(undefined), undefined);
  });
});
