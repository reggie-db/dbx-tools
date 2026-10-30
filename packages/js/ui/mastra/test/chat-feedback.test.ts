import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import {
  genieFeedbackTarget,
  messageFeedbackDestination,
  mlflowTraceUrl,
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

  it("links the debug action to the captured trace", () => {
    assert.equal(
      mlflowTraceUrl(
        "https://fevm-reggie-pierce-aws.cloud.databricks.com/ml/experiments/3223948959631242?o=7474652124440999&compareRunsMode=TRACES#history",
        "tr-8156ad2745bba108216846a69549cf7e",
        "reggie_pierce_aws_catalog.mlflow_traces.demo",
      ),
      "https://fevm-reggie-pierce-aws.cloud.databricks.com/ml/experiments/3223948959631242/traces?o=7474652124440999&selectedEvaluationId=tr-8156ad2745bba108216846a69549cf7e&traceId=trace%3A%2Freggie_pierce_aws_catalog.mlflow_traces.demo%2F8156ad2745bba108216846a69549cf7e",
    );
    assert.equal(mlflowTraceUrl("https://workspace.example.com/ml/experiments/123"), undefined);
  });
});
