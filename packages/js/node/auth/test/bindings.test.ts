import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAuthClient } from "../src/bindings.ts";

describe("auth bindings", () => {
  it("exposes the stateful authentication client factory", () => {
    assert.equal(typeof createAuthClient, "function");
  });
});
