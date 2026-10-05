import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ClientProtocol,
  GatewayRoute,
  ModelCapabilities,
  ModelTarget,
  UpstreamProtocol,
} from "@dbx-tools/shared-model-gateway";
import { gatewayResponseHeaders, upstreamUrl } from "../src/transport.ts";

describe("model gateway transport", () => {
  it("maps every direct protocol to its documented Databricks path", () => {
    const host = "https://workspace.example.com";
    const expectations: Array<[UpstreamProtocol, ClientProtocol, string]> = [
      [
        "databricks-ai-gateway-codex",
        "openai-responses",
        "https://workspace.example.com/ai-gateway/codex/v1/responses",
      ],
      [
        "databricks-responses",
        "openai-responses",
        "https://workspace.example.com/serving-endpoints/responses",
      ],
      [
        "databricks-open-responses",
        "openai-responses",
        "https://workspace.example.com/serving-endpoints/open-responses",
      ],
      [
        "databricks-chat",
        "openai-chat",
        "https://workspace.example.com/serving-endpoints/chat/completions",
      ],
      [
        "databricks-anthropic",
        "anthropic-messages",
        "https://workspace.example.com/serving-endpoints/anthropic/v1/messages",
      ],
      [
        "databricks-embeddings",
        "openai-embeddings",
        "https://workspace.example.com/serving-endpoints/databricks-gpt-test/invocations",
      ],
    ];

    for (const [upstreamProtocol, clientProtocol, expected] of expectations) {
      assert.equal(upstreamUrl(host, route(upstreamProtocol, clientProtocol)), expected);
    }
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

function route(upstreamProtocol: UpstreamProtocol, clientProtocol: ClientProtocol): GatewayRoute {
  return {
    clientProtocol,
    upstreamProtocol,
    target: TARGET,
    upstreamModel: TARGET.id,
    translateRequest: false,
    translateResponse: false,
  };
}

const CAPABILITIES: ModelCapabilities = {
  responses: true,
  openResponses: true,
  chat: true,
  anthropic: true,
  embeddings: false,
  aiGatewayCodex: true,
  tools: true,
  reasoning: true,
  streaming: true,
  parallelTools: true,
  customTools: true,
  structuredOutput: true,
  webSearch: true,
};

const TARGET: ModelTarget = {
  id: "databricks-gpt-test",
  aliases: ["databricks-gpt-test"],
  displayName: "GPT test",
  capabilities: CAPABILITIES,
  reasoningEfforts: [],
};
