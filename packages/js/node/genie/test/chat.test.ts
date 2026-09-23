import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkspaceClient } from "@databricks/appkit";
import { genieModel } from "@dbx-tools/shared-genie";

import { isAgentModeUnavailable } from "../src/agent-mode.ts";
import { genieChat } from "../src/chat.ts";

const AGENT_ID = "agent-1";

function agentStream(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const split = Math.floor(encoded.length / 2);
      controller.enqueue(encoded.slice(0, split));
      controller.enqueue(encoded.slice(split));
      controller.close();
    },
  });
}

describe("genieChat Agent Mode", () => {
  it("classifies only feature-disabled Agent Mode errors as fallback candidates", () => {
    assert.equal(
      isAgentModeUnavailable({
        errorCode: "FEATURE_DISABLED",
        message: "Workspace is not enrolled.",
      }),
      true,
    );
    assert.equal(
      isAgentModeUnavailable({
        errorCode: "NOT_FOUND",
        message: "Conversation not found.",
      }),
      false,
    );
  });

  it("streams Agent Mode by default and projects response items", async () => {
    const output = [
      {
        type: "reasoning",
        id: "reason-1",
        content: [{ type: "reasoning_text", text: "Find the relevant metric" }],
      },
      {
        type: "function_call",
        id: "call-item-1",
        call_id: "call-1",
        name: "execute_sql",
        arguments: JSON.stringify({ sql: "SELECT 1 AS value" }),
      },
      {
        type: "function_call_output",
        id: "call-1_output",
        call_id: "call-1",
        output: "value\n\n| value |\n| --- |\n| 1 |",
      },
      {
        type: "message",
        id: "message-1",
        content: [{ type: "output_text", text: "The value is 1." }],
      },
    ];
    const client = {
      apiClient: {
        request: async (request: {
          path: string;
          raw: boolean;
          payload: Record<string, unknown>;
        }) => {
          assert.equal(request.path, `/api/2.0/genie/agents/${AGENT_ID}/responses`);
          assert.equal(request.raw, true);
          assert.deepEqual(request.payload, {
            input: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "What is the value?" }],
              },
            ],
          });
          return {
            contents: agentStream([
              {
                type: "response.created",
                sequence_number: 0,
                response: {
                  id: "response-1",
                  status: "in_progress",
                  conversation_id: "conversation-1",
                  output: [],
                },
              },
              ...output.map((item, output_index) => ({
                type: "response.output_item.done",
                sequence_number: output_index + 1,
                output_index,
                item,
              })),
              {
                type: "response.completed",
                sequence_number: 5,
                response: {
                  id: "response-1",
                  status: "completed",
                  conversation_id: "conversation-1",
                  created_at: 1_748_383_200,
                  output,
                },
              },
            ]),
          };
        },
      },
      genie: {
        startConversation: async () => {
          throw new Error("polling must not run");
        },
      },
    } as unknown as WorkspaceClient;

    const messages = [];
    for await (const message of genieChat(AGENT_ID, "What is the value?", {
      workspaceClient: client,
    })) {
      messages.push(message);
    }

    const final = messages.at(-1)!;
    assert.doesNotThrow(() => genieModel.GenieMessageSchema.parse(final));
    assert.equal(final.status, "COMPLETED");
    assert.equal(final.conversation_id, "conversation-1");
    assert.equal(final.attachments?.[0]?.query?.thoughts?.[0]?.content, "Find the relevant metric");
    assert.equal(final.attachments?.[1]?.query?.query, "SELECT 1 AS value");
    assert.equal(final.attachments?.[2]?.text?.content.includes("| value |"), true);
    assert.equal(final.attachments?.[3]?.text?.content, "The value is 1.");
  });

  it("falls back to polling when Agent Mode is unavailable", async () => {
    const client = {
      apiClient: {
        request: async () => {
          throw new Error("FEATURE_DISABLED: preview toggle is off");
        },
      },
      genie: {
        startConversation: async () => ({
          conversation_id: "poll-conversation",
          message_id: "poll-message",
          message: {
            id: "poll-message",
            message_id: "poll-message",
            conversation_id: "poll-conversation",
            space_id: AGENT_ID,
            content: "Fallback question",
            status: "COMPLETED",
          },
        }),
      },
    } as unknown as WorkspaceClient;

    const messages = [];
    for await (const message of genieChat(AGENT_ID, "Fallback question", {
      workspaceClient: client,
    })) {
      messages.push(message);
    }

    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.conversation_id, "poll-conversation");
  });

  it("projects a cancelled Agent Mode response as terminal", async () => {
    const client = {
      apiClient: {
        request: async () => ({
          contents: agentStream([
            {
              type: "response.completed",
              response: {
                id: "response-1",
                status: "cancelled",
                conversation_id: "conversation-1",
                output: [],
              },
            },
          ]),
        }),
      },
    } as unknown as WorkspaceClient;

    const messages = [];
    for await (const message of genieChat(AGENT_ID, "Question", {
      workspaceClient: client,
    })) {
      messages.push(message);
    }

    assert.equal(messages.at(-1)?.status, "CANCELLED");
  });

  it("rejects malformed Agent Mode SSE events", async () => {
    const client = {
      apiClient: {
        request: async () => ({
          contents: agentStream([
            {
              type: "response.created",
              response: { status: "in_progress", output: [] },
            },
          ]),
        }),
      },
    } as unknown as WorkspaceClient;

    await assert.rejects(async () => {
      for await (const _message of genieChat(AGENT_ID, "Question", {
        workspaceClient: client,
      })) {
        // The malformed envelope must fail before yielding a message.
      }
    }, /id/);
  });

  it("rejects premature EOF and cancels the server response", async () => {
    const requests: string[] = [];
    const client = {
      apiClient: {
        request: async (request: { path: string }) => {
          requests.push(request.path);
          return request.path.endsWith("/cancel")
            ? {}
            : {
                contents: agentStream([
                  {
                    type: "response.created",
                    response: {
                      id: "response-1",
                      status: "in_progress",
                      conversation_id: "conversation-1",
                      output: [],
                    },
                  },
                ]),
              };
        },
      },
    } as unknown as WorkspaceClient;

    await assert.rejects(async () => {
      for await (const _message of genieChat(AGENT_ID, "Question", {
        workspaceClient: client,
      })) {
        // Consume the complete stream.
      }
    }, /before a terminal response/);
    assert.equal(requests.at(-1)?.endsWith("/cancel"), true);
  });

  it("cancels the Agent Mode response body when the consumer stops", async () => {
    let cancelled = false;
    const requests: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              type: "response.created",
              response: {
                id: "response-1",
                status: "in_progress",
                conversation_id: "conversation-1",
                output: [],
              },
            })}\n\n`,
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = {
      apiClient: {
        request: async (request: { path: string }) => {
          requests.push(request.path);
          return request.path.endsWith("/cancel") ? {} : { contents: stream };
        },
      },
    } as unknown as WorkspaceClient;

    for await (const _message of genieChat(AGENT_ID, "Question", {
      workspaceClient: client,
    })) {
      break;
    }

    assert.equal(cancelled, true);
    assert.deepEqual(requests, [
      `/api/2.0/genie/agents/${AGENT_ID}/responses`,
      `/api/2.0/genie/agents/${AGENT_ID}/conversations/conversation-1/responses/response-1/cancel`,
    ]);
  });
});
