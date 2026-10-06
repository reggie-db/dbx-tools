import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveLocalRegistry } from "../tasks/lib/local-publish.ts";

describe("local release publication", () => {
  it("disables local npm publication explicitly", () => {
    assert.equal(resolveLocalRegistry("false"), undefined);
    assert.equal(resolveLocalRegistry(""), undefined);
  });

  it("keeps an explicit local npm registry unchanged", () => {
    assert.equal(resolveLocalRegistry("http://127.0.0.1:4873"), "http://127.0.0.1:4873");
  });
});
