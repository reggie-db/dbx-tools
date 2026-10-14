import { describe, expect, test } from "bun:test";
import type { WorkspaceClient } from "@databricks/appkit";
import type { GenieMessage } from "@dbx-tools/shared-genie";
import { wire } from "@dbx-tools/shared-mastra";

import {
  deleteGenieThreadMessage,
  genieAnswerText,
  genieMessageToUiMessages,
  listGenieThreadMessages,
  listGenieThreads,
} from "../src/genie-chat.ts";

const SPACE = { alias: "default", spaceId: "space-1" };

function genieMessage(overrides: Partial<GenieMessage> = {}): GenieMessage {
  return {
    id: "msg-1",
    message_id: "msg-1",
    space_id: SPACE.spaceId,
    conversation_id: "conv-1",
    content: "Top stores?",
    status: "COMPLETED",
    created_timestamp: 1,
    attachments: [{ text: { content: "Store 7 leads." } }],
    ...overrides,
  } as GenieMessage;
}

describe("genieAnswerText", () => {
  test("joins text attachments and embeds polled statements", () => {
    const text = genieAnswerText(
      genieMessage({
        attachments: [
          { text: { content: "Revenue by region." } },
          { query: { query: "SELECT 1", description: "Q3 totals", statement_id: "stmt-9" } },
        ],
      }),
    );
    expect(text).toBe("Revenue by region.\n\nQ3 totals\n\n[data:stmt-9]");
  });

  test("embeds a native visualization for a visualized query and drops its Markdown copy", () => {
    const text = genieAnswerText(
      genieMessage({
        attachments: [
          { attachment_id: "q1", query: { query: "SELECT 1", statement_id: "stmt-1" } },
          {
            attachment_id: "out1",
            text: { content: "| a |\n| --- |\n| 1 |", metadata: { statement_id: "stmt-1" } },
          },
          { attachment_id: "q2", query: { query: "SELECT 2", statement_id: "stmt-2" } },
          { attachment_id: "viz1", viz: { title: "Trend", query_attachment_id: "q1" } },
          { text: { content: "Sales dipped, then recovered." } },
        ],
      }),
    );
    expect(text).toBe("Sales dipped, then recovered.\n\n[visualization:stmt-1]\n\n[data:stmt-2]");
  });

  test("falls back to the Genie error for an empty failed message", () => {
    const text = genieAnswerText(
      genieMessage({ status: "FAILED", attachments: [], error: { error: "Warehouse stopped" } }),
    );
    expect(text).toBe("Warehouse stopped");
  });
});

describe("genieMessageToUiMessages", () => {
  test("projects a question and an ask_genie answer", () => {
    const [user, assistant] = genieMessageToUiMessages(genieMessage(), SPACE);
    expect(user).toEqual({
      id: "msg-1:question",
      role: "user",
      parts: [{ type: "text", text: "Top stores?" }],
    });
    expect(assistant?.id).toBe("msg-1");
    const tool = assistant?.parts[0] as { type: string; state: string; input: unknown };
    expect(tool.type).toBe("tool-ask_genie");
    expect(tool.state).toBe("output-available");
    expect(tool.input).toEqual({ question: "Top stores?" });
    expect(assistant?.parts.some((part) => part.type === wire.GENIE_PROGRESS_PART_TYPE)).toBe(true);
    expect(assistant?.parts.at(-1)).toEqual({
      type: "text",
      text: "Store 7 leads.",
      state: "done",
    });
  });

  test("marks a failed Genie message as a tool error", () => {
    const [, assistant] = genieMessageToUiMessages(
      genieMessage({ status: "FAILED", attachments: [], error: { error: "boom" } }),
      { alias: "sales", spaceId: "space-2" },
    );
    const tool = assistant?.parts[0] as { type: string; state: string; errorText: string };
    expect(tool.type).toBe("tool-ask_genie_sales");
    expect(tool.state).toBe("output-error");
    expect(tool.errorText).toBe("boom");
  });
});

describe("Genie conversation APIs", () => {
  test("lists only Agent Mode conversations newest first", async () => {
    const calls: unknown[] = [];
    const client = {
      genie: {
        listConversations: async (request: unknown) => {
          calls.push(request);
          return {
            conversations: [
              {
                conversation_id: "old",
                title: "Old",
                created_timestamp: 1_000,
                agent_type: "GENIE_CONVERSATION_TYPE_AGENT",
              },
              {
                conversation_id: "legacy",
                title: "Legacy",
                created_timestamp: 3_000,
                agent_type: "GENIE_CONVERSATION_TYPE_CHAT",
              },
              {
                conversation_id: "new",
                title: "New",
                created_timestamp: 2_000,
                agent_type: "GENIE_CONVERSATION_TYPE_AGENT",
              },
            ],
          };
        },
      },
    } as unknown as WorkspaceClient;

    const threads = await listGenieThreads(client, SPACE);
    expect(threads.map((thread) => thread.id)).toEqual(["new", "old"]);
    expect(calls[0]).toMatchObject({ space_id: "space-1" });
  });

  test("loads Agent Mode history from conversation items", async () => {
    const meta = { message_id: "m1" };
    const requests: string[] = [];
    const client = {
      apiClient: {
        request: async (request: { path: string; query: unknown }) => {
          requests.push(request.path);
          expect(request.query).toMatchObject({ limit: 100, order: "asc" });
          return {
            has_more: false,
            status: "completed",
            data: [
              {
                type: "message",
                role: "user",
                id: "m1_input",
                metadata: meta,
                content: [{ type: "input_text", text: "Plot sales" }],
              },
              {
                type: "reasoning",
                id: "r1",
                metadata: meta,
                content: [{ type: "reasoning_text", text: "Weekly trend." }],
              },
              {
                type: "function_call",
                id: "q1",
                call_id: "q1",
                name: "execute_sql",
                arguments: JSON.stringify({ sql: "SELECT 1", title: "Sales" }),
                metadata: meta,
              },
              {
                type: "function_call_output",
                id: "q1_out",
                call_id: "q1",
                output: "| week | sales |",
                metadata: { ...meta, statement_id: "stmt-1" },
              },
              {
                type: "function_call_output",
                id: "v1_out",
                call_id: "v1",
                output: "Sales trend",
                metadata: { ...meta, viz: { attachment_id: "v1", query_attachment_id: "q1" } },
              },
              {
                type: "message",
                role: "assistant",
                id: "a1",
                metadata: meta,
                content: [{ type: "output_text", text: "Sales recovered." }],
              },
            ],
          };
        },
      },
    } as unknown as WorkspaceClient;

    const messages = await listGenieThreadMessages({
      client,
      space: SPACE,
      conversationId: "conv-1",
    });
    expect(requests[0]).toContain("/api/2.0/genie/agents/space-1/conversations/conv-1/items");
    expect(messages.map((message) => message.id)).toEqual(["m1:question", "m1"]);
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "Plot sales" }]);
    expect(messages[1]?.parts.at(-1)).toEqual({
      type: "text",
      text: "Sales recovered.\n\n[visualization:stmt-1]",
      state: "done",
    });
  });

  test("deletes the Genie message behind a question transcript id", async () => {
    let deleted: unknown;
    const client = {
      genie: {
        deleteConversationMessage: async (request: unknown) => {
          deleted = request;
        },
      },
    } as unknown as WorkspaceClient;
    await deleteGenieThreadMessage(client, SPACE, "conv-1", "msg-1:question");
    expect(deleted).toEqual({
      space_id: "space-1",
      conversation_id: "conv-1",
      message_id: "msg-1",
    });
  });
});
