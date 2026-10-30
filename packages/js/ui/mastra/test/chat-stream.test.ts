import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MLFLOW_TRACE_PART_TYPE,
  MODEL_ROUTE_PART_TYPE,
  MODEL_USAGE_PART_TYPE,
  RESPONSE_COMPLETE_PART_TYPE,
  THREAD_TITLE_PART_TYPE,
} from "@dbx-tools/shared-mastra";
import type { UIMessageChunk } from "ai";

import {
  closeOnTerminalChunk,
  chatStatusForChunk,
  readMlflowTracePart,
  readModelRoutePart,
  readModelUsagePart,
  readThreadTitlePart,
  waitForTerminalChunk,
} from "../src/react/chat-stream.ts";

describe("model usage parts", () => {
  it("reads model routes before usage completes", () => {
    const data = readModelRoutePart({
      type: MODEL_ROUTE_PART_TYPE,
      data: {
        runId: "run-1",
        model: "databricks-gpt-5-4",
        selection: "smart-router",
      },
    } as UIMessageChunk);

    assert.equal(data?.model, "databricks-gpt-5-4");
  });

  it("reads caller-facing routing and usage data", () => {
    const data = readModelUsagePart({
      type: MODEL_USAGE_PART_TYPE,
      data: {
        runId: "run-1",
        model: "databricks-gpt-test",
        selection: "smart-router",
        usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
        estimatedCostDbu: 0.00002,
      },
    } as UIMessageChunk);

    assert.equal(data?.model, "databricks-gpt-test");
    assert.equal(data?.usage.totalTokens, 10);
  });
});

describe("chat stream completion", () => {
  it("closes after forwarding the finish chunk without waiting for upstream", async () => {
    let cancelled = false;
    let terminal = false;
    const upstream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: "start", messageId: "assistant-1" });
        controller.enqueue({ type: "finish", finishReason: "stop" });
      },
      cancel() {
        cancelled = true;
      },
    });

    const chunks: UIMessageChunk[] = [];
    for await (const chunk of closeOnTerminalChunk(upstream, () => (terminal = true))) {
      chunks.push(chunk);
    }

    assert.deepEqual(chunks, [
      { type: "start", messageId: "assistant-1" },
      { type: "finish", finishReason: "stop" },
    ]);
    assert.equal(cancelled, true);
    assert.equal(terminal, true);
  });

  it("cancels the locked upstream reader when the consumer stops", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: "start", messageId: "assistant-1" });
      },
      cancel() {
        cancelled = true;
      },
    });
    const stream = closeOnTerminalChunk(upstream);
    const reader = stream.getReader();

    await reader.read();
    await reader.cancel("stop");

    assert.equal(cancelled, true);
  });

  it("does not treat a step boundary as terminal", async () => {
    let terminal = false;
    const upstream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: "start-step" });
        controller.enqueue({ type: "finish-step" });
        controller.enqueue({ type: "finish", finishReason: "stop" });
      },
    });

    const chunks: UIMessageChunk[] = [];
    for await (const chunk of closeOnTerminalChunk(upstream, () => (terminal = true))) {
      chunks.push(chunk);
    }

    assert.deepEqual(
      chunks.map((chunk) => chunk.type),
      ["start-step", "finish-step", "finish"],
    );
    assert.equal(terminal, true);
  });

  it("enters finishing only for the response-complete marker", () => {
    assert.equal(chatStatusForChunk({ type: "finish-step" }), undefined);
    assert.equal(
      chatStatusForChunk({
        type: RESPONSE_COMPLETE_PART_TYPE,
        data: null,
        transient: true,
      } as UIMessageChunk),
      "finishing",
    );
  });

  it("keeps finishing through the terminal chunk until synchronized state applies", () => {
    assert.equal(chatStatusForChunk({ type: "finish", finishReason: "stop" }), "finishing");
    assert.equal(chatStatusForChunk({ type: "abort", reason: "interrupted" }), "finishing");
  });

  it("treats a streamed error as terminal and releases the upstream reader", async () => {
    let cancelled = false;
    let terminal = false;
    const errorChunk = {
      type: "error",
      errorText: "Provider rejected the request",
    } as UIMessageChunk;
    const upstream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue(errorChunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    const chunks: UIMessageChunk[] = [];
    for await (const chunk of closeOnTerminalChunk(upstream, () => (terminal = true))) {
      chunks.push(chunk);
    }

    assert.deepEqual(chunks, [errorChunk]);
    assert.equal(chatStatusForChunk(errorChunk), "error");
    assert.equal(cancelled, true);
    assert.equal(terminal, true);
  });

  it("rejects a stream that closes before finish or abort", async () => {
    const upstream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: "start", messageId: "assistant-1" });
        controller.close();
      },
    });

    await assert.rejects(async () => {
      for await (const _chunk of closeOnTerminalChunk(upstream)) {
        // Drain until the wrapper detects the missing terminal chunk.
      }
    }, /ended before a terminal AI SDK chunk/);
  });

  it("reads the transient MLflow trace fallback", () => {
    const traceId = "tr-0123456789abcdef0123456789abcdef";
    assert.equal(
      readMlflowTracePart({
        type: MLFLOW_TRACE_PART_TYPE,
        data: { traceId },
        transient: true,
      } as UIMessageChunk),
      traceId,
    );
  });

  it("reads the synchronized thread title data part", () => {
    assert.equal(
      readThreadTitlePart({
        type: THREAD_TITLE_PART_TYPE,
        data: { title: "Synchronized Title" },
        transient: true,
      } as UIMessageChunk),
      "Synchronized Title",
    );
  });

  it("waits for an abort chunk and cancels the remaining observation", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: "start", messageId: "assistant-1" });
        controller.enqueue({ type: "abort", reason: "interrupted" });
      },
      cancel() {
        cancelled = true;
      },
    });

    await waitForTerminalChunk(upstream);

    assert.equal(cancelled, true);
  });
});
