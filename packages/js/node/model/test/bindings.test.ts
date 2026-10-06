import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResolveModelRouteOptions } from "../src/bindings.ts";

describe("model binding facade", () => {
  it("uses plain binding-friendly option records", () => {
    const options: ResolveModelRouteOptions = {
      model: "gpt 5",
      modelClass: "chat-balanced",
      protocol: "chat",
    };

    assert.deepEqual(options, {
      model: "gpt 5",
      modelClass: "chat-balanced",
      protocol: "chat",
    });
  });
});
