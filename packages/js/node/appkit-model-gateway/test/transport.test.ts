import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { directDatabricksRequestBody, gatewayResponseHeaders } from "../src/transport.ts";

describe("model gateway transport", () => {
  it("drops unsupported parallel tool settings from direct Responses requests", () => {
    assert.deepEqual(
      directDatabricksRequestBody(
        {
          upstreamProtocol: "databricks-open-responses",
          upstreamModel: "databricks-gpt-5-6-sol",
        },
        {
          model: "gpt",
          input: "hello",
          parallel_tool_calls: true,
        },
      ),
      {
        model: "databricks-gpt-5-6-sol",
        input: "hello",
      },
    );
  });

  it("reuses the model-owned field sanitizer for direct Chat requests", () => {
    assert.deepEqual(
      directDatabricksRequestBody(
        {
          upstreamProtocol: "databricks-chat",
          upstreamModel: "databricks-gpt-5-6-sol",
        },
        {
          model: "gpt",
          messages: [],
          parallel_tool_calls: false,
          metadata: {},
        },
      ),
      {
        model: "databricks-gpt-5-6-sol",
        messages: [],
      },
    );
  });

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
