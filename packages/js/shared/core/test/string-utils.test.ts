import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Language, polygotTest } from "@dbx-tools/test-polyglot/polyglot";
import { PACKAGE_IDENTIFIER, stringUtils } from "../index.ts";

const identifierContract = {
  toIdentifier(...input: unknown[]): string {
    const values = [...input];
    const last = values.at(-1);
    const options =
      last !== null &&
      typeof last === "object" &&
      !Array.isArray(last) &&
      typeof (last as { delimiter?: unknown }).delimiter === "string"
        ? (values.pop() as { delimiter: string })
        : {};
    return stringUtils.toIdentifierWithOptions(options, ...values);
  },
};

describe("stringUtils.trimToEmpty", () => {
  it("trims a string", () => {
    assert.equal(stringUtils.trimToEmpty("  hi  "), "hi");
  });

  it("yields an empty string for a non-string or blank value", () => {
    assert.equal(stringUtils.trimToEmpty(undefined), "");
    assert.equal(stringUtils.trimToEmpty(null), "");
    assert.equal(stringUtils.trimToEmpty(42), "");
    assert.equal(stringUtils.trimToEmpty("   "), "");
  });
});

describe("stringUtils.parseList", () => {
  it("splits a comma / whitespace separated string", () => {
    assert.deepEqual(stringUtils.parseList("a, b  c,d"), ["a", "b", "c", "d"]);
  });

  it("accepts an array and trims its entries", () => {
    assert.deepEqual(stringUtils.parseList([" a ", "b"]), ["a", "b"]);
  });

  it("drops empties and de-duplicates, first occurrence winning", () => {
    assert.deepEqual(stringUtils.parseList("a,,b, a ,b"), ["a", "b"]);
  });

  it("returns an empty list for absent input", () => {
    assert.deepEqual(stringUtils.parseList(undefined), []);
    assert.deepEqual(stringUtils.parseList(null), []);
    assert.deepEqual(stringUtils.parseList(""), []);
  });

  it("applies a transform and de-duplicates on the transformed value", () => {
    assert.deepEqual(
      stringUtils.parseList("A, a, B", (entry) => entry.trim().toLowerCase()),
      ["a", "b"],
    );
  });
});

await polygotTest(
  async () => ({ PACKAGE_IDENTIFIER, string: identifierContract }),
  "string",
  (implementation, language) => {
    describe(`stringUtils.toIdentifier (${language})`, () => {
      it("joins multiple values", () => {
        assert.equal(implementation.toIdentifier("billing", "Prod"), "billing-prod");
      });

      it("splits camel case", () => {
        assert.equal(implementation.toIdentifier("myApp"), "my-app");
      });

      it("tokenizes an acronym boundary", () => {
        assert.equal(implementation.toIdentifier("XMLHttpRequest"), "xml-http-request");
      });

      it("normalizes punctuation", () => {
        assert.equal(implementation.toIdentifier("already_snake"), "already-snake");
        assert.equal(implementation.toIdentifier("fixtureOverride"), "fixture-override");
      });
    });
  },
  { identifiers: { [Language.Python]: "dbx_tools.core.string" } },
);

describe("string tokenize capitalize overrides", () => {
  it("uppercases ai and fs when capitalizing", () => {
    assert.deepEqual(
      [...stringUtils.tokenizeWithOptions({ lowerCase: true, capitalize: true }, "local-fs")],
      ["Local", "FS"],
    );
    assert.deepEqual(
      [...stringUtils.tokenizeWithOptions({ lowerCase: true, capitalize: true }, "ai-tools")],
      ["AI", "Tools"],
    );
    assert.equal(stringUtils.toLabel("local-fs"), "Local FS");
  });
});
