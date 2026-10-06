import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModelClient } from "../src/bindings.ts";

describe("model bindings", () => {
  it("exposes the stateful model client factory", () => {
    assert.equal(typeof createModelClient, "function");
  });
});
