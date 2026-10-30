import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import {
  genieFeedbackTarget,
  messageFeedbackDestination,
} from "../src/react/chat-feedback.ts";

describe("Genie Agent feedback target", () => {
  it("recovers the latest ask_genie message identity", () => {
    const message: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-1",
          toolName: "ask_genie",
          state: "output-available",
          input: { question: "What were sales?" },
          output: {
            message: {
              id: "message-1",
              message_id: "message-1",
              conversation_id: "conversation-1",
              space_id: "space-1",
              content: "What were sales?",
              status: "COMPLETED",
            },
          },
        },
      ],
    };
    assert.deepEqual(genieFeedbackTarget(message), {
      spaceId: "space-1",
      conversationId: "conversation-1",
      messageId: "message-1",
    });
  });

  it("routes Genie results to Genie before the enclosing MLflow trace", () => {
    const message: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-1",
          toolName: "ask_genie",
          state: "output-available",
          input: { question: "What were sales?" },
          output: {
            message: {
              id: "message-1",
              message_id: "message-1",
              conversation_id: "conversation-1",
              space_id: "space-1",
              content: "What were sales?",
              status: "COMPLETED",
            },
          },
        },
      ],
    };

    assert.deepEqual(
      messageFeedbackDestination(
        message,
        ["genie", "mlflow"],
        "tr-0123456789abcdef0123456789abcdef",
      ),
      {
        mode: "genie",
        spaceId: "space-1",
        conversationId: "conversation-1",
        messageId: "message-1",
      },
    );
  });

  it("routes ordinary traced responses to MLflow", () => {
    const message: UIMessage = {
      id: "assistant-2",
      role: "assistant",
      parts: [{ type: "text", text: "Answer" }],
    };

    assert.deepEqual(
      messageFeedbackDestination(
        message,
        ["genie", "mlflow"],
        "tr-0123456789abcdef0123456789abcdef",
      ),
      { mode: "mlflow", traceId: "tr-0123456789abcdef0123456789abcdef" },
    );
    assert.equal(messageFeedbackDestination(message, ["genie"]), undefined);
  });
});
