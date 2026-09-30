import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ListMemoryThreadMessagesResponse } from "@mastra/client-js";

import { toChronologicalUiMessages } from "../src/react/_history-messages.ts";

describe("native memory history conversion", () => {
  it("converts persisted messages when the server omits uiMessages", () => {
    const response = {
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          createdAt: "2026-09-29T12:01:00.000Z",
          content: {
            format: 2,
            parts: [{ type: "text", text: "It is sunny in Paris." }],
          },
        },
        {
          id: "user-1",
          role: "user",
          createdAt: "2026-09-29T12:00:00.000Z",
          content: {
            format: 2,
            parts: [{ type: "text", text: "What is the weather in Paris?" }],
          },
        },
      ],
      uiMessages: null,
      hasMore: false,
    } as unknown as ListMemoryThreadMessagesResponse;

    const messages = toChronologicalUiMessages(response);

    assert.deepEqual(
      messages.map(({ id, role }) => ({ id, role })),
      [
        { id: "user-1", role: "user" },
        { id: "assistant-1", role: "assistant" },
      ],
    );
    assert.deepEqual(messages[1]?.parts, [
      { type: "text", text: "It is sunny in Paris.", providerMetadata: undefined },
    ]);
  });

  it("uses server-projected uiMessages when present", () => {
    const response = {
      messages: [],
      uiMessages: [
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "newest" }],
        },
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "oldest" }],
        },
      ],
    } as unknown as ListMemoryThreadMessagesResponse;

    assert.deepEqual(
      toChronologicalUiMessages(response).map(({ id }) => id),
      ["user-1", "assistant-1"],
    );
  });
});
