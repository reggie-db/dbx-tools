import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assistantTextFromJson,
  assistantTextFromSse,
  CHAT_GENIE_USED_ATTR,
  CHAT_IDENTITY_ATTR,
  CHAT_MESSAGES_ATTR,
  CHAT_RESPONSE_ATTR,
  chatTurnTelemetryMiddleware,
  MLFLOW_GENIE_TAG_ATTR,
  MLFLOW_SESSION_ATTR,
  MLFLOW_SPAN_INPUTS_ATTR,
  MLFLOW_SPAN_OUTPUTS_ATTR,
  MLFLOW_SPAN_TYPE_ATTR,
  MLFLOW_USER_ATTR,
  textOnlyChatInput,
  TRACE_IO_LIMIT,
} from "../src/telemetry.ts";

describe("assistantTextFromSse", () => {
  it("reassembles text-delta frames and ignores keepalives", () => {
    const body = [
      ": keepalive",
      'data: {"type":"text-delta","payload":{"text":"Hello"}}',
      'data: {"type":"step-start"}',
      'data: {"type":"text-delta","payload":{"text":" world"}}',
      "data: not-json",
      "",
    ].join("\n");
    assert.equal(assistantTextFromSse(body), "Hello world");
  });

  it("reads official AI SDK text-delta frames", () => {
    const body = [
      'data: {"type":"text-delta","id":"answer","delta":"Hello"}',
      'data: {"type":"text-delta","id":"answer","delta":" world"}',
      "data: [DONE]",
      "",
    ].join("\n");
    assert.equal(assistantTextFromSse(body), "Hello world");
  });

  it("returns empty string when no text-delta frames are present", () => {
    assert.equal(assistantTextFromSse('data: {"type":"finish"}\n'), "");
  });

  it("caps the assembled answer at the trace payload limit", () => {
    const answer = "x".repeat(TRACE_IO_LIMIT + 100);
    assert.equal(
      assistantTextFromSse(`data: ${JSON.stringify({ type: "text-delta", delta: answer })}\n`),
      "x".repeat(TRACE_IO_LIMIT),
    );
  });
});

describe("assistantTextFromJson", () => {
  it("reads and caps the text from a generate result", () => {
    assert.equal(assistantTextFromJson({ text: "complete answer" }), "complete answer");
    assert.equal(
      assistantTextFromJson({ text: "x".repeat(TRACE_IO_LIMIT + 100) }),
      "x".repeat(TRACE_IO_LIMIT),
    );
  });

  it("ignores responses without text", () => {
    assert.equal(assistantTextFromJson({ output: "not the generate shape" }), "");
    assert.equal(assistantTextFromJson(undefined), "");
  });
});

describe("textOnlyChatInput", () => {
  it("unwraps one text-only user message", () => {
    assert.equal(
      textOnlyChatInput([
        {
          id: "message-1",
          role: "user",
          parts: [{ type: "text", text: "raw prompt" }],
        },
      ]),
      "raw prompt",
    );
    assert.equal(
      textOnlyChatInput([{ role: "user", content: "content prompt" }]),
      "content prompt",
    );
  });

  it("preserves structured and multi-message input as JSON", () => {
    assert.equal(
      textOnlyChatInput([
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ]),
      undefined,
    );
    assert.equal(
      textOnlyChatInput([
        {
          role: "user",
          parts: [
            { type: "text", text: "describe" },
            { type: "file", url: "volume://image.png" },
          ],
        },
      ]),
      undefined,
    );
  });
});

describe("chatTurnTelemetryMiddleware", () => {
  it("skips non-agent routes without touching the response", () => {
    let nextCalls = 0;
    const req = {
      method: "GET",
      path: "/agents/support/stream",
      body: {},
    };
    const res = { write: () => true, end: () => undefined, json: () => undefined };
    chatTurnTelemetryMiddleware(req as never, res as never, () => {
      nextCalls += 1;
    });
    assert.equal(nextCalls, 1);
    assert.equal(typeof res.write, "function");
  });

  it("skips when there is no active span even on an agent POST", () => {
    let nextCalls = 0;
    const writes: unknown[] = [];
    const req = {
      method: "POST",
      path: "/agents/support/stream",
      body: { messages: [{ role: "user", content: "hi" }] },
    };
    const res = {
      write(...args: unknown[]) {
        writes.push(args[0]);
        return true;
      },
      end() {
        return undefined;
      },
      json() {
        return undefined;
      },
      once() {
        return undefined;
      },
    };
    chatTurnTelemetryMiddleware(req as never, res as never, () => {
      nextCalls += 1;
    });
    assert.equal(nextCalls, 1);
    // No active span -> middleware must not wrap write/end.
    res.write("unchanged");
    assert.deepEqual(writes, ["unchanged"]);
  });
});

describe("telemetry constants", () => {
  it("exposes the MLflow attribute keys the UC view reads", () => {
    assert.equal(MLFLOW_SPAN_INPUTS_ATTR, "mlflow.spanInputs");
    assert.equal(MLFLOW_SPAN_OUTPUTS_ATTR, "mlflow.spanOutputs");
    assert.equal(CHAT_MESSAGES_ATTR, "appkit.mastra.chat.messages");
    assert.equal(CHAT_RESPONSE_ATTR, "appkit.mastra.chat.response");
    assert.equal(CHAT_IDENTITY_ATTR, "appkit.mastra.identity.mode");
    assert.equal(CHAT_GENIE_USED_ATTR, "appkit.mastra.genie.used");
    assert.equal(MLFLOW_SPAN_TYPE_ATTR, "mlflow.spanType");
    assert.equal(MLFLOW_USER_ATTR, "user.id");
    assert.equal(MLFLOW_SESSION_ATTR, "session.id");
    assert.equal(MLFLOW_GENIE_TAG_ATTR, "mlflow.trace.tag.genie");
    assert.ok(TRACE_IO_LIMIT > 0);
  });
});
