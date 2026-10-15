import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { agentMode } from "../index.ts";

describe("Genie Agent Mode contracts", () => {
  it("projects SQL titles, result output, and cancelled status", () => {
    const response = agentMode.GenieAgentResponseSchema.parse({
      id: "response-1",
      status: "cancelled",
      conversation_id: "conversation-1",
      output: [
        {
          type: "function_call",
          id: "call-1",
          call_id: "call-1",
          name: "execute_sql",
          arguments: JSON.stringify({ title: "Top customers", sql: "SELECT 1" }),
        },
        {
          type: "function_call_output",
          id: "call-1_output",
          call_id: "call-1",
          output: "Top customers\n\n| value |\n| --- |\n| 1 |",
          metadata: { statement_id: "statement-1" },
        },
        {
          type: "function_call_output",
          id: "viz-1_output",
          call_id: "viz-1",
          output: "Top customers",
          metadata: {
            viz: { attachment_id: "viz-1", query_attachment_id: "call-1" },
          },
        },
        {
          type: "message",
          id: "message-1",
          content: [
            {
              type: "output_text",
              text: "Structured table",
              metadata: {
                columns: [{ name: "value" }],
                preview_rows: [[1]],
                row_count: 1,
                status: "completed",
                sql: "SELECT 1",
              },
            },
          ],
        },
      ],
    });

    const message = agentMode.projectAgentModeMessage(
      "space-1",
      "Question",
      response,
      response.output ?? [],
    );

    assert.equal(message.status, "CANCELLED");
    assert.equal(message.attachments?.[0]?.query?.title, "Top customers");
    assert.equal(message.attachments?.[0]?.query?.query, "SELECT 1");
    assert.equal(message.attachments?.[0]?.query?.statement_id, "statement-1");
    assert.equal(message.attachments?.[1]?.text?.content.includes("| value |"), true);
    assert.deepEqual(message.attachments?.[2]?.viz, {
      title: "Top customers",
      query_attachment_id: "call-1",
    });
    assert.deepEqual(message.attachments?.[3]?.text?.metadata, {
      columns: [{ name: "value" }],
      preview_rows: [[1]],
      row_count: 1,
      status: "completed",
      sql: "SELECT 1",
    });
  });

  it("preserves the latest in-progress status during history projection", () => {
    const messages = agentMode.projectAgentModeConversation(
      "space-1",
      "conversation-1",
      [
        {
          type: "message",
          role: "user",
          id: "message-1_input",
          content: [{ type: "input_text", text: "Show sales" }],
          status: "completed",
        },
        {
          type: "function_call",
          id: "query-item-1",
          call_id: "query-call-1",
          name: "execute_sql",
          arguments: JSON.stringify({ sql: "SELECT 1" }),
          status: "in_progress",
        },
      ],
      "in_progress",
    );

    assert.equal(messages[0]?.status, "EXECUTING_QUERY");
    assert.equal(messages[0]?.message_id, "message-1");
    assert.equal(messages[0]?.attachments?.[0]?.attachment_id, "query-call-1");
  });

  it("segments documented multi-turn items at each user input", () => {
    const messages = agentMode.projectAgentModeConversation("space-1", "conversation-1", [
      {
        type: "message",
        role: "user",
        id: "turn-1_input",
        content: [{ type: "input_text", text: "First" }],
      },
      {
        type: "message",
        role: "assistant",
        id: "answer-1",
        content: [{ type: "output_text", text: "One" }],
      },
      {
        type: "message",
        role: "user",
        id: "turn-2_input",
        content: [{ type: "input_text", text: "Second" }],
      },
      {
        type: "message",
        role: "assistant",
        id: "answer-2",
        content: [{ type: "output_text", text: "Two" }],
      },
    ]);

    assert.deepEqual(
      messages.map((message) => ({
        id: message.message_id,
        question: message.content,
        answer: message.attachments?.[0]?.text?.content,
      })),
      [
        { id: "turn-1", question: "First", answer: "One" },
        { id: "turn-2", question: "Second", answer: "Two" },
      ],
    );
  });
});
