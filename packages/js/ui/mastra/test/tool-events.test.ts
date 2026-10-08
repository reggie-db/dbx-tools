import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";

import {
  genieReasoningText,
  mergeToolEvents,
  toolEventsFromParts,
} from "../src/support/tool-events.ts";

describe("native persisted tool events", () => {
  it("projects complete native dynamic-tool input and output", () => {
    const input = { storeId: "store-1" };
    const output = { rows: Array.from({ length: 500 }, (_, index) => ({ index })) };
    const parts: UIMessage["parts"] = [
      {
        type: "dynamic-tool",
        toolCallId: "tool-1",
        toolName: "lookup_store",
        state: "output-available",
        input,
        output,
      },
    ];

    assert.deepEqual(toolEventsFromParts(parts), [
      {
        id: "tool-1",
        toolName: "lookup_store",
        status: "done",
        input,
        output,
      },
    ]);
  });

  it("attaches native Genie progress data parts to their tool call", () => {
    const parts = [
      {
        type: "dynamic-tool",
        toolCallId: "tool-1",
        toolName: "ask_genie",
        state: "input-available",
        input: { question: "How many orders?" },
      },
      {
        type: "data-genie-progress",
        data: {
          toolCallId: "tool-1",
          event: {
            type: "started",
            spaceId: "space-1",
            content: "How many orders?",
          },
        },
      },
    ] as unknown as UIMessage["parts"];

    assert.deepEqual(toolEventsFromParts(parts), [
      {
        id: "tool-1",
        toolName: "ask_genie",
        status: "running",
        input: { question: "How many orders?" },
        progress: [
          {
            type: "started",
            spaceId: "space-1",
            content: "How many orders?",
          },
        ],
      },
    ]);
  });

  it("merges live progress over the persisted native event", () => {
    const persisted = [
      {
        id: "tool-1",
        toolName: "lookup_store",
        status: "done" as const,
        input: { storeId: "store-1" },
        output: { ok: true },
      },
    ];
    const progress = [{ type: "started" as const, content: "Looking up store" }];

    assert.deepEqual(
      mergeToolEvents(persisted, [
        {
          id: "tool-1",
          toolName: "lookup_store",
          status: "done",
          progress,
        },
      ]),
      [{ ...persisted[0], progress }],
    );
  });

  it("collects Genie thinking for the assistant reasoning panel", () => {
    assert.equal(
      genieReasoningText([
        {
          id: "tool-1",
          toolName: "ask_genie",
          status: "running",
          progress: [
            {
              type: "thinking",
              space_id: "space-1",
              conversation_id: "conversation-1",
              message_id: "message-1",
              attachment_id: "attachment-1",
              thought_type: "THOUGHT_TYPE_DESCRIPTION",
              text: "Finding the relevant sales data.",
            },
            {
              type: "status",
              space_id: "space-1",
              conversation_id: "conversation-1",
              message_id: "message-1",
              status: "EXECUTING_QUERY",
            },
            {
              type: "text",
              space_id: "space-1",
              conversation_id: "conversation-1",
              message_id: "message-1",
              attachment_id: "answer-1",
              text: "Final intermediate answer.\n\n| store | sales |\n| --- | --- |\n| 1003 | 9407 |",
            },
            {
              type: "thinking",
              space_id: "space-1",
              conversation_id: "conversation-1",
              message_id: "message-1",
              attachment_id: "attachment-1",
              thought_type: "THOUGHT_TYPE_STEPS",
              text: "Comparing the current period with last quarter.",
            },
          ],
        },
      ]),
      "Finding the relevant sales data.\n\nComparing the current period with last quarter.",
    );
  });

  it("drops markdown tables from Genie thinking text", () => {
    assert.equal(
      genieReasoningText([
        {
          id: "tool-1",
          toolName: "ask_genie",
          status: "running",
          progress: [
            {
              type: "thinking",
              text: "Sampling the view.\n\n| store | sales |\n| --- | --- |\n| 1003 | 9407 |\n\nBeer leads.",
            },
          ],
        },
      ]),
      "Sampling the view.\n\nBeer leads.",
    );
  });
});
