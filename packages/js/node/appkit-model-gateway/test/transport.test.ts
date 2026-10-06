import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gatewayResponseHeaders } from "../src/transport.ts";

describe("model gateway transport", () => {
  it("forwards protocol headers without leaking upstream cookies", () => {
    const headers = gatewayResponseHeaders(
      new Headers({
        "content-type": "text/event-stream",
        "x-provider-metadata": "preserved",
        "x-request-id": "request-1",
        "set-cookie": "secret=1",
      }),
    );

    assert.equal(headers.get("content-type"), "text/event-stream");
    assert.equal(headers.get("x-provider-metadata"), "preserved");
    assert.equal(headers.get("x-request-id"), "request-1");
    assert.equal(headers.has("set-cookie"), false);
  });
});
