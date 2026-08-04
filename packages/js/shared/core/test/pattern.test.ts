import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeRegExp, toPattern, toPatternMatcher } from "../src/pattern.ts";

describe("toPattern", () => {
  it("matches a literal whole-string, case-insensitively", () => {
    const match = toPattern("x-request-id");
    assert.ok(match);
    assert.equal(match("x-request-id"), true);
    assert.equal(match("X-Request-Id"), true);
    // Literal means WHOLE string: a prefix is not a match.
    assert.equal(match("x-request-id-2"), false);
    assert.equal(match("y-x-request-id"), false);
  });

  it("honours caseSensitive for literals and globs", () => {
    assert.equal(toPattern("x-A", { caseSensitive: true })!("x-a"), false);
    assert.equal(toPattern("x-A*", { caseSensitive: true })!("x-a1"), false);
    assert.equal(toPattern("x-A*", { caseSensitive: true })!("x-A1"), true);
  });

  it("compiles a glob anchored at both ends", () => {
    const match = toPattern("x-mastra-*")!;
    assert.equal(match("x-mastra-thread-id"), true);
    assert.equal(match("x-mastra-"), true);
    assert.equal(match("y-x-mastra-a"), false);
    assert.equal(toPattern("x-?")!("x-a"), true);
    assert.equal(toPattern("x-?")!("x-ab"), false);
  });

  it("escapes regex metacharacters inside a glob", () => {
    // The `.` is literal; only `*` is a wildcard.
    const match = toPattern("x-app.*")!;
    assert.equal(match("x-app.trace"), true);
    assert.equal(match("x-appXtrace"), false);
  });

  it("compiles a /regex/ literal with flags", () => {
    assert.equal(toPattern("/^x-trace-/")!("x-trace-id"), true);
    assert.equal(toPattern("/^x-trace-/")!("y-trace-id"), false);
    // Unanchored, so a regex may match a substring - unlike a literal or glob.
    assert.equal(toPattern("/mastra/")!("x-mastra-model"), true);
  });

  it("skips an empty entry and an invalid regex instead of throwing", () => {
    assert.equal(toPattern("   "), undefined);
    assert.equal(toPattern("/(unclosed/"), undefined);
  });
});

describe("toPatternMatcher", () => {
  it("ORs every entry and accepts a delimited string or an array", () => {
    const fromArray = toPatternMatcher(["x-mastra-*", "/^x-mlflow-/"]);
    const fromString = toPatternMatcher("x-mastra-*, /^x-mlflow-/");
    for (const match of [fromArray, fromString]) {
      assert.equal(match("x-mastra-model"), true);
      assert.equal(match("x-mlflow-trace-id"), true);
      assert.equal(match("x-forwarded-user"), false);
    }
  });

  it("matches nothing when there are no usable patterns", () => {
    for (const input of [undefined, null, "", [], ["  "], ["/(bad/"]]) {
      assert.equal(toPatternMatcher(input)("anything"), false);
    }
  });

  it("composes as a predicate", () => {
    const match = toPatternMatcher("x-*").and((value) => !value.endsWith("-id"));
    assert.equal(match("x-model"), true);
    assert.equal(match("x-thread-id"), false);
  });
});

describe("escapeRegExp", () => {
  it("escapes metacharacters so a value matches literally", () => {
    assert.equal(new RegExp(`^${escapeRegExp("a.b*c")}$`).test("a.b*c"), true);
    assert.equal(new RegExp(`^${escapeRegExp("a.b*c")}$`).test("axbbbc"), false);
  });
});
