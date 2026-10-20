import { describe, expect, test } from "bun:test";
import type { WorkspaceClient } from "@databricks/appkit";
import type { GenieMessage } from "@dbx-tools/shared-genie";
import { GENIE_PROGRESS_PART_TYPE } from "@dbx-tools/shared-mastra";
import type { MastraMemory } from "@mastra/core/memory";
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from "@mastra/core/request-context";

import {
  deleteGenieThreadMessage,
  genieAnswerText,
  genieChatStream,
  genieMessageToUiMessages,
  listGenieThreadMessages,
  listGenieThreads,
  visibleGenieQuestion,
  visibleGenieThreadTitle,
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

function agentStream(events: object[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
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

  test("keeps native visualization placeholders in the answer's prose order", () => {
    const text = genieAnswerText(
      genieMessage({
        attachments: [
          { attachment_id: "q1", query: { query: "SELECT 1", statement_id: "stmt-1" } },
          { attachment_id: "v1", viz: { query_attachment_id: "q1" } },
          { attachment_id: "q2", query: { query: "SELECT 2", statement_id: "stmt-2" } },
          { attachment_id: "v2", viz: { query_attachment_id: "q2" } },
          { text: { content: "Overview." } },
          { text: { content: "", metadata: { viz: { attachment_id: "v1" } } } },
          { text: { content: "Inside sales improved." } },
          { text: { content: "", metadata: { viz: { attachment_id: "v2" } } } },
          { text: { content: "Fuel revenue rose because of pricing." } },
        ],
      }),
    );

    expect(text).toBe(
      "Overview.\n\n[visualization:stmt-1]\n\nInside sales improved.\n\n[visualization:stmt-2]\n\nFuel revenue rose because of pricing.",
    );
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
    expect(assistant?.parts.some((part) => part.type === GENIE_PROGRESS_PART_TYPE)).toBe(true);
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

  test("hides context augmentation from reloaded questions", () => {
    const content =
      '<dbx-tools-genie-context>\nApplication context:\n{"storeId":"store-1"}' +
      "\n</dbx-tools-genie-context>\n\nHow is this store performing?";
    expect(visibleGenieQuestion(content)).toBe("How is this store performing?");
    const [user] = genieMessageToUiMessages(genieMessage({ content }), SPACE);
    expect(user?.parts).toEqual([{ type: "text", text: "How is this store performing?" }]);
  });

  test("sanitizes complete context titles and omits truncated envelopes", () => {
    const complete =
      '<dbx-tools-genie-context>\nApplication context:\n{"storeId":"store-1"}' +
      "\n</dbx-tools-genie-context>\n\nHow is this store performing?";
    expect(visibleGenieThreadTitle("Quarterly performance")).toBe("Quarterly performance");
    expect(visibleGenieThreadTitle(complete)).toBe("How is this store performing?");
    expect(visibleGenieThreadTitle("<dbx-tools-genie-context> Use t")).toBeUndefined();
  });
});

describe("direct Genie context and memory", () => {
  test("injects native request context and resource-scoped Mastra recall", async () => {
    let payload: Record<string, unknown> | undefined;
    const output = [
      {
        type: "message",
        id: "answer-1",
        content: [{ type: "output_text", text: "Store 1 is above target." }],
      },
    ];
    const client = {
      apiClient: {
        request: async (request: { payload: Record<string, unknown> }) => {
          payload = request.payload;
          return {
            contents: agentStream([
              {
                type: "response.created",
                sequence_number: 0,
                response: {
                  id: "response-1",
                  status: "in_progress",
                  conversation_id: "conv-1",
                  output: [],
                },
              },
              {
                type: "response.output_item.done",
                sequence_number: 1,
                output_index: 0,
                item: output[0],
              },
              {
                type: "response.completed",
                sequence_number: 2,
                response: {
                  id: "response-1",
                  status: "completed",
                  conversation_id: "conv-1",
                  output,
                },
              },
            ]),
          };
        },
      },
    } as unknown as WorkspaceClient;
    const saved: unknown[] = [];
    const memory = {
      listThreads: async () => ({
        threads: [{ id: "prior-thread" }],
        total: 1,
        page: 0,
        perPage: 1,
        hasMore: false,
      }),
      getMergedThreadConfig: (config: unknown) => config,
      recall: async () => ({
        messages: [
          {
            id: "prior-1",
            role: "user",
            createdAt: new Date(),
            threadId: "prior-thread",
            resourceId: "user-1",
            content: {
              format: 2,
              parts: [{ type: "text", text: "Store 1 is the selected location." }],
            },
          },
        ],
        total: 1,
        page: 0,
        perPage: false,
        hasMore: false,
      }),
      getThreadById: async () => null,
      createThread: async (options: unknown) => {
        saved.push({ thread: options });
        return {};
      },
      saveMessages: async (options: unknown) => {
        saved.push(options);
        return { messages: [] };
      },
    } as unknown as MastraMemory;
    const requestContext = new RequestContext<unknown>();
    requestContext.setRaw(MASTRA_RESOURCE_ID_KEY, "user-1");
    const stream = genieChatStream({
      client,
      space: SPACE,
      request: {
        question: "How is this store performing?",
        requestContext: { storeId: "store-1" },
      },
      memory,
      requestContext,
    });
    const reader = stream.getReader();
    while (!(await reader.read()).done) {
      // Drain the stream so memory persistence completes.
    }

    const input = payload?.input as Array<{ content: Array<{ text: string }> }>;
    expect(input[0]?.content[0]?.text).toContain('"storeId": "store-1"');
    expect(input[0]?.content[0]?.text).toContain("Store 1 is the selected location.");
    expect(input[0]?.content[0]?.text).toContain("How is this store performing?");
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({
      messages: [
        { role: "user", resourceId: "user-1" },
        { role: "assistant", resourceId: "user-1" },
      ],
    });
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

  test("recovers a truncated polluted title from the first visible question", async () => {
    const content =
      '<dbx-tools-genie-context>\nApplication context:\n{"storeId":"store-1"}' +
      "\n</dbx-tools-genie-context>\n\nHow is this store performing?";
    const client = {
      genie: {
        listConversations: async () => ({
          conversations: [
            {
              conversation_id: "polluted",
              title: "<dbx-tools-genie-context> Use t",
              created_timestamp: 1_000,
              agent_type: "GENIE_CONVERSATION_TYPE_AGENT",
            },
          ],
        }),
      },
      apiClient: {
        request: async () => ({
          has_more: false,
          status: "completed",
          data: [
            {
              type: "message",
              role: "user",
              id: "m1_input",
              content: [{ type: "input_text", text: content }],
            },
          ],
        }),
      },
    } as unknown as WorkspaceClient;

    await expect(listGenieThreads(client, SPACE)).resolves.toEqual([
      {
        id: "polluted",
        title: "How is this store performing?",
        createdAt: new Date(1_000).toISOString(),
      },
    ]);
  });

  test("loads Agent Mode history from conversation items", async () => {
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
                content: [{ type: "input_text", text: "Plot sales" }],
              },
              {
                type: "reasoning",
                id: "r1",
                content: [{ type: "reasoning_text", text: "Weekly trend." }],
              },
              {
                type: "function_call",
                id: "query-item-1",
                call_id: "query-call-1",
                name: "execute_sql",
                arguments: JSON.stringify({ sql: "SELECT 1", title: "Sales" }),
              },
              {
                type: "function_call_output",
                id: "q1_out",
                call_id: "query-call-1",
                output: "| week | sales |",
                metadata: { statement_id: "stmt-1" },
              },
              {
                type: "function_call_output",
                id: "v1_out",
                call_id: "v1",
                output: "Sales trend",
                metadata: {
                  viz: { attachment_id: "v1", query_attachment_id: "query-call-1" },
                },
              },
              {
                type: "message",
                role: "assistant",
                id: "a1",
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
