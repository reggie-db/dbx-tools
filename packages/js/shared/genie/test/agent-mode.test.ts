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
    assert.equal(message.attachments?.[1]?.text?.content.includes("| value |"), true);
    assert.deepEqual(message.attachments?.[2]?.text?.metadata, {
      columns: [{ name: "value" }],
      preview_rows: [[1]],
      row_count: 1,
      status: "completed",
      sql: "SELECT 1",
    });
  });
});
