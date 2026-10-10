import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeGatewayRequest } from "../src/gateway-decode.ts";

describe("gateway protocol decoding", () => {
  it("consolidates Codex developer instructions into one system message", () => {
    const decoded = decodeGatewayRequest("openai-responses", {
      input: [
        { type: "message", role: "developer", content: "First instruction" },
        { type: "message", role: "developer", content: "Second instruction" },
        { type: "message", role: "user", content: "Hello" },
      ],
    });

    assert.deepEqual(decoded.messages, [
      { role: "system", content: "First instruction\n\nSecond instruction" },
      { role: "user", content: "Hello" },
    ]);
  });

  it("maps a Codex custom tool to a provider-safe object schema", () => {
    const decoded = decodeGatewayRequest("openai-responses", {
      input: "Hello",
      tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
    });

    assert.ok(decoded.tools.apply_patch);
  });
});
