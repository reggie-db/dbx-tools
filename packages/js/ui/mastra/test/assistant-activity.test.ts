import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";

import { assistantActivityItems } from "../src/react/_assistant-activity.ts";
import type { ToolEvent } from "../src/react/types.ts";

describe("assistantActivityItems", () => {
  it("interleaves model and tool thoughts with tool pills in message order", () => {
    const parts = [
      { type: "reasoning", text: "Planning the lookup." },
      {
        type: "dynamic-tool",
        toolCallId: "tool-1",
        toolName: "lookup_store",
        state: "input-available",
        input: {},
      },
      { type: "reasoning", text: "Checking the result." },
      {
        type: "dynamic-tool",
        toolCallId: "tool-2",
        toolName: "render_data",
        state: "input-available",
        input: {},
      },
    ] as UIMessage["parts"];
    const events: ToolEvent[] = [
      {
        id: "tool-1",
        toolName: "lookup_store",
        status: "running",
        progress: [
          {
            type: "thinking",
            space_id: "space-1",
            conversation_id: "conversation-1",
            message_id: "message-1",
            attachment_id: "attachment-1",
            thought_type: "THOUGHT_TYPE_DESCRIPTION",
            text: "Reading the store record.",
          },
        ],
      },
      { id: "tool-2", toolName: "render_data", status: "running" },
    ];

    assert.deepEqual(
      assistantActivityItems(parts, events).map((item) =>
        item.type === "tool" ? `tool:${item.event.id}` : `thought:${item.text}`,
      ),
      [
        "thought:Planning the lookup.",
        "tool:tool-1",
        "thought:Reading the store record.",
        "thought:Checking the result.",
        "tool:tool-2",
      ],
    );
  });

  it("appends live tools that are not present in native message parts", () => {
    assert.deepEqual(
      assistantActivityItems(
        [],
        [{ id: "live-tool", toolName: "web_search", status: "running" }],
      ).map((item) => item.key),
      ["tool-live-tool"],
    );
  });

  it("groups one tool call's Genie thoughts into one disclosure", () => {
    const items = assistantActivityItems(
      [
        {
          type: "dynamic-tool",
          toolCallId: "genie-1",
          toolName: "ask_genie",
          state: "input-available",
          input: {},
        },
      ] as UIMessage["parts"],
      [
        {
          id: "genie-1",
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
              text: "First thought.",
            },
            {
              type: "thinking",
              space_id: "space-1",
              conversation_id: "conversation-1",
              message_id: "message-1",
              attachment_id: "attachment-1",
              thought_type: "THOUGHT_TYPE_DESCRIPTION",
              text: "Second thought.",
            },
          ],
        },
      ],
    );

    assert.deepEqual(
      items.map((item) => (item.type === "tool" ? `tool:${item.event.id}` : item.text)),
      ["tool:genie-1", "First thought.\n\nSecond thought."],
    );
  });

  it("renders persisted Genie attachment thoughts like model reasoning summaries", () => {
    const items = assistantActivityItems(
      [
        {
          type: "dynamic-tool",
          toolCallId: "genie-1",
          toolName: "ask_genie",
          state: "output-available",
          input: { question: "What were inside sales this week?" },
          output: {
            message: {
              id: "message-1",
              message_id: "message-1",
              conversation_id: "conversation-1",
              space_id: "space-1",
              content: "What were inside sales this week?",
              status: "COMPLETED",
              attachments: [
                {
                  attachment_id: "query-1",
                  query: {
                    id: "query-1",
                    thoughts: [
                      {
                        thought_type: "THOUGHT_TYPE_STEPS",
                        content: "I'm pulling the latest complete reporting week.",
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      ] as UIMessage["parts"],
      [
        {
          id: "genie-1",
          toolName: "ask_genie",
          status: "done",
          output: {
            message: {
              id: "message-1",
              message_id: "message-1",
              conversation_id: "conversation-1",
              space_id: "space-1",
              content: "What were inside sales this week?",
              status: "COMPLETED",
              attachments: [
                {
                  attachment_id: "query-1",
                  query: {
                    id: "query-1",
                    thoughts: [
                      {
                        thought_type: "THOUGHT_TYPE_STEPS",
                        content: "I'm pulling the latest complete reporting week.",
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    );

    assert.deepEqual(
      items.map((item) => (item.type === "tool" ? `tool:${item.event.id}` : `thought:${item.text}`)),
      ["tool:genie-1", "thought:I'm pulling the latest complete reporting week."],
    );
  });
});
