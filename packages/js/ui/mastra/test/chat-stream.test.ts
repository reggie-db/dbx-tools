import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessageChunk } from "ai";

import { closeOnTerminalChunk } from "../src/react/chat-stream.ts";

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
});
