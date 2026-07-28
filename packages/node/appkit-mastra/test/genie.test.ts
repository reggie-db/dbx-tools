import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type { GenieMessage } from "@dbx-tools/shared-genie";
import { RequestContext } from "@mastra/core/request-context";

import { MASTRA_USER_KEY } from "../src/config.ts";
import { buildGenieTools } from "../src/genie.ts";

const SPACE_ID = "space-1";
const CONTEXT_KEY = `mastra__genie_conversation__${SPACE_ID}`;

function completedMessage(
  conversationId: string,
  messageId: string,
  content: string,
): GenieMessage {
  return {
    space_id: SPACE_ID,
    conversation_id: conversationId,
    message_id: messageId,
    content,
    status: "COMPLETED",
  } as GenieMessage;
}

describe("Genie Mastra tools", () => {
  it("isolates parallel calls while preserving sequential conversation reuse", async () => {
    let releaseReusableCall!: () => void;
    let reusableCallStarted!: () => void;
    const reusableCallGate = new Promise<void>((resolve) => {
      releaseReusableCall = resolve;
    });
    const reusableCallSignal = new Promise<void>((resolve) => {
      reusableCallStarted = resolve;
    });
    const calls: Array<{ method: "create" | "start"; conversationId?: string; content: string }> =
      [];

    const client = {
      genie: {
        createMessage: async (input: {
          conversation_id: string;
          content: string;
        }): Promise<GenieMessage & { wait: () => Promise<GenieMessage> }> => {
          calls.push({
            method: "create",
            conversationId: input.conversation_id,
            content: input.content,
          });
          reusableCallStarted();
          await reusableCallGate;
          const message = completedMessage(
            input.conversation_id,
            `message-${calls.length}`,
            input.content,
          );
          return { ...message, wait: async () => message };
        },
        startConversation: async (input: { content: string }) => {
          calls.push({ method: "start", content: input.content });
          const message = completedMessage(
            "isolated-conversation",
            "isolated-message",
            input.content,
          );
          return {
            conversation_id: message.conversation_id,
            message_id: message.message_id,
            message,
          };
        },
        getMessage: async () => {
          throw new Error("terminal messages must not be polled again");
        },
      },
    } as unknown as WorkspaceClient;

    const requestContext = new RequestContext();
    requestContext.set(MASTRA_USER_KEY, {
      id: "user-1",
      executionContext: { client },
    });
    requestContext.set(CONTEXT_KEY, "reusable-conversation");

    const askGenie = buildGenieTools({
      spaces: { default: SPACE_ID },
      config: {},
    }).ask_genie as unknown as {
      execute(
        input: { question: string },
        ctx: { requestContext: RequestContext },
      ): Promise<unknown>;
    };

    const first = askGenie.execute({ question: "first" }, { requestContext });
    await reusableCallSignal;
    await askGenie.execute({ question: "parallel" }, { requestContext });

    assert.deepEqual(calls.slice(0, 2), [
      {
        method: "create",
        conversationId: "reusable-conversation",
        content: "first",
      },
      { method: "start", content: "parallel" },
    ]);

    releaseReusableCall();
    await first;
    await askGenie.execute({ question: "follow-up" }, { requestContext });

    assert.deepEqual(calls[2], {
      method: "create",
      conversationId: "reusable-conversation",
      content: "follow-up",
    });
  });
});
