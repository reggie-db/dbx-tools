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

describe("stringUtils.dedent", () => {
  it("removes common indentation and surrounding blank lines", () => {
    assert.equal(
      stringUtils.dedent(`
        if ready; then
          run
        fi
      `),
      "if ready; then\n  run\nfi",
    );
  });

  it("right-strips lines while preserving relative indentation", () => {
    assert.equal(stringUtils.dedent("  first  \n    second\t\n\n"), "first\n  second");
  });

  it("can preserve spaces and tabs at line ends", () => {
    assert.equal(
      stringUtils.dedent("  first  \n    second\t", { trimLineEnd: false }),
      "first  \n  second\t",
    );
  });

  it("returns an empty string for empty or blank input", () => {
    assert.equal(stringUtils.dedent(""), "");
    assert.equal(stringUtils.dedent("\n  \n\t\n"), "");
  });

  it("can preserve leading and trailing blank lines", () => {
    assert.equal(
      stringUtils.dedent("\n  first\n    second\n", { trimStart: false, trimEnd: false }),
      "\nfirst\n  second\n",
    );
  });

  it("returns normalized lines without joining them", () => {
    assert.deepEqual(stringUtils.dedentLines("\n  first\n    second\n"), ["first", "  second"]);
    assert.deepEqual(stringUtils.dedentLines("\n  first\n   \n    second\n"), [
      "first",
      "",
      "  second",
    ]);
    assert.deepEqual(stringUtils.dedentLines("\n  first\n", { trimEnd: false }), ["first", ""]);
    assert.deepEqual(stringUtils.dedentLines(""), []);
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
