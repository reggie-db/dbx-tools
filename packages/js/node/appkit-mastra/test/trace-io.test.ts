import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assistantTextFromJson,
  assistantTextFromSse,
  chatTurnTraceIoMiddleware,
  MLFLOW_SPAN_INPUTS_ATTR,
  MLFLOW_SPAN_OUTPUTS_ATTR,
  TRACE_IO_LIMIT,
} from "../src/trace-io.ts";

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

describe("chatTurnTraceIoMiddleware", () => {
  it("skips non-agent routes without touching the response", () => {
    let nextCalls = 0;
    const req = {
      method: "GET",
      path: "/agents/support/stream",
      body: {},
    };
    const res = { write: () => true, end: () => undefined, json: () => undefined };
    chatTurnTraceIoMiddleware(req as never, res as never, () => {
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
    chatTurnTraceIoMiddleware(req as never, res as never, () => {
      nextCalls += 1;
    });
    assert.equal(nextCalls, 1);
    // No active span -> middleware must not wrap write/end.
    res.write("unchanged");
    assert.deepEqual(writes, ["unchanged"]);
  });
});

describe("trace-io constants", () => {
  it("exposes the MLflow attribute keys the UC view reads", () => {
    assert.equal(MLFLOW_SPAN_INPUTS_ATTR, "mlflow.spanInputs");
    assert.equal(MLFLOW_SPAN_OUTPUTS_ATTR, "mlflow.spanOutputs");
    assert.ok(TRACE_IO_LIMIT > 0);
  });
});
