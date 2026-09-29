import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { MastraPluginClient } from "../src/support/mastra-client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("MastraPluginClient native agent transport", () => {
  it("uses native stream processing with isolated routing and request context", async () => {
    let received!: Request;
    globalThis.fetch = (async (input, init) => {
      received = new Request(input, init);
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const client = new MastraPluginClient({
      basePath: "/api/mastra",
      defaultAgent: "support",
      agents: ["support"],
      feedbackEnabled: false,
      chatAlwaysAvailable: true,
    });

    const response = await client.streamAgent({
      agentId: "support",
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "hello" }] }],
      runId: "run-1",
      threadId: "thread-1",
      model: "model-1",
      requestContext: { storeId: "store-1" },
    });
    await response.processDataStream({ onChunk: () => assert.fail("unexpected chunk") });

    assert.equal(received.url, "http://localhost/api/mastra/agents/support/stream");
    assert.equal(received.headers.get("x-mastra-thread-id"), "thread-1");
    assert.equal(received.headers.get("x-mastra-model"), "model-1");
    const body = await received.json();
    assert.equal(body.runId, "run-1");
    assert.deepEqual(body.requestContext, { storeId: "store-1" });
  });

  it("reuses the run context for native approval continuation", async () => {
    let received!: Request;
    globalThis.fetch = (async (input, init) => {
      received = new Request(input, init);
      return new Response(
        `data: ${JSON.stringify({
          type: "tool-result",
          payload: {
            toolCallId: "tool-1",
            toolName: "lookup",
            result: { ok: true },
          },
        })}\n\ndata: [DONE]\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    }) as typeof fetch;
    const client = new MastraPluginClient({
      basePath: "/api/mastra",
      defaultAgent: "support",
      agents: ["support"],
      feedbackEnabled: false,
      chatAlwaysAvailable: true,
    });

    const response = await client.approveToolCallStream("support", {
      runId: "run-1",
      toolCallId: "tool-1",
      threadId: "thread-1",
      requestContext: { storeId: "store-1" },
    });
    const chunks: string[] = [];
    await response.processDataStream({
      onChunk: (chunk) => {
        chunks.push(chunk.type);
      },
    });

    assert.equal(received.url, "http://localhost/api/mastra/agents/support/approve-tool-call");
    assert.equal(received.headers.get("x-mastra-thread-id"), "thread-1");
    assert.deepEqual((await received.json()).requestContext, { storeId: "store-1" });
    assert.deepEqual(chunks, ["tool-result"]);
  });
});
