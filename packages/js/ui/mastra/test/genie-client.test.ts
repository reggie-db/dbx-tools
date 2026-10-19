import { afterEach, describe, expect, test } from "bun:test";
import { wire } from "@dbx-tools/shared-mastra";
import { RequestContext } from "@mastra/client-js";
import type { UIMessage } from "ai";
import { GenieChatClient } from "../src/support/genie-client.ts";

const CONFIG = { basePath: "/api/mastra", defaultAgent: "support", agents: ["support"] };
const originalFetch = globalThis.fetch;

/** Encode AI SDK UI chunks as the SSE body the chat routes return. */
function sseResponse(chunks: object[]): Response {
  const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"];
  return new Response(body.join(""), { headers: { "content-type": "text/event-stream" } });
}

const question = (text: string): UIMessage => ({
  id: `user-${text}`,
  role: "user",
  parts: [{ type: "text", text }],
});

async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GenieChatClient", () => {
  test("adopts the announced conversation and continues it on the next turn", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponse([
        { type: "start" },
        {
          type: wire.GENIE_CONVERSATION_PART_TYPE,
          data: { conversationId: "conv-1", messageId: "msg-1" },
          transient: true,
        },
        { type: "finish" },
      ]);
    }) as typeof fetch;
    const client = new GenieChatClient(CONFIG, "default");
    const requestContext = new RequestContext<{ storeId: string }>([
      ["storeId", "store-1"],
    ]);

    const first = await client.streamAgent({
      agentId: "genie:default",
      messages: [question("Top stores?")],
      runId: "run-1",
      threadId: "local-1",
      requestContext,
    });
    await drain(first.stream);
    expect(first.threadId?.()).toBe("conv-1");
    expect(bodies[0]).toMatchObject({
      question: "Top stores?",
      requestContext: { storeId: "store-1" },
    });
    expect(bodies[0]).not.toHaveProperty("conversationId");

    const second = await client.streamAgent({
      agentId: "genie:default",
      messages: [question("And last year?")],
      runId: "run-2",
      threadId: "conv-1",
    });
    await drain(second.stream);
    expect(bodies[1]).toMatchObject({ question: "And last year?", conversationId: "conv-1" });
  });

  test("deletes only Genie messages it can map", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        urls.push(String(input));
        return new Response(null, { status: 204 });
      }
      return sseResponse([
        {
          type: wire.GENIE_CONVERSATION_PART_TYPE,
          data: { conversationId: "conv-1", messageId: "msg-1" },
          transient: true,
        },
        { type: "finish" },
      ]);
    }) as typeof fetch;
    const client = new GenieChatClient(CONFIG, "default");
    const turn = await client.streamAgent({
      agentId: "genie:default",
      messages: [question("Top stores?")],
      runId: "run-1",
      threadId: "local-1",
    });
    await drain(turn.stream);

    await client.deleteMessages("conv-1", ["user-Top stores?", "assistant-unknown"]);
    expect(urls).toEqual(["/api/mastra/genie/default/threads/conv-1/messages/msg-1"]);
  });

  test("validates projected history with the AI SDK", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/threads")) {
        return Response.json({
          threads: [{ id: "conv-1", title: "Conversation", createdAt: "2026-10-14T00:00:00Z" }],
        });
      }
      return Response.json({
        messages: [{ id: "bad", role: "invalid", parts: [] }],
      });
    }) as typeof fetch;
    const client = new GenieChatClient(CONFIG, "default");
    await client.threads();

    await expect(client.history({ threadId: "conv-1" })).rejects.toThrow();
  });

  test("loads a deep-linked conversation that is absent from the first thread page", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        messages: [
          { id: "user-1", role: "user", parts: [{ type: "text", text: "Question" }] },
          { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "Answer" }] },
        ],
      })) as typeof fetch;
    const client = new GenieChatClient(CONFIG, "default");

    const history = await client.history({ threadId: "older-conversation" });

    expect(history.uiMessages?.map((message) => (message as UIMessage).id)).toEqual([
      "assistant-1",
      "user-1",
    ]);
  });
});
