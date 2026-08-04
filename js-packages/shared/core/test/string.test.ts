import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { string } from "../index.ts";

describe("string.trimToEmpty", () => {
  it("trims a string", () => {
    assert.equal(string.trimToEmpty("  hi  "), "hi");
  });

  it("yields an empty string for a non-string or blank value", () => {
    assert.equal(string.trimToEmpty(undefined), "");
    assert.equal(string.trimToEmpty(null), "");
    assert.equal(string.trimToEmpty(42), "");
    assert.equal(string.trimToEmpty("   "), "");
  });
});

describe("string.parseList", () => {
  it("splits a comma / whitespace separated string", () => {
    assert.deepEqual(string.parseList("a, b  c,d"), ["a", "b", "c", "d"]);
  });

  it("accepts an array and trims its entries", () => {
    assert.deepEqual(string.parseList([" a ", "b"]), ["a", "b"]);
  });

  it("drops empties and de-duplicates, first occurrence winning", () => {
    assert.deepEqual(string.parseList("a,,b, a ,b"), ["a", "b"]);
  });

  it("returns an empty list for absent input", () => {
    assert.deepEqual(string.parseList(undefined), []);
    assert.deepEqual(string.parseList(null), []);
    assert.deepEqual(string.parseList(""), []);
  });

  it("applies a transform and de-duplicates on the transformed value", () => {
    assert.deepEqual(
      string.parseList("A, a, B", (entry) => entry.trim().toLowerCase()),
      ["a", "b"],
    );
  });
});

describe("string tokenize capitalize overrides", () => {
  it("uppercases ai and fs when capitalizing", () => {
    assert.deepEqual(
      [...string.tokenizeWithOptions({ lowerCase: true, capitalize: true }, "local-fs")],
      ["Local", "FS"],
    );
    assert.deepEqual(
      [...string.tokenizeWithOptions({ lowerCase: true, capitalize: true }, "ai-tools")],
      ["AI", "Tools"],
    );
    assert.equal(string.toLabel("local-fs"), "Local FS");
  });
});
