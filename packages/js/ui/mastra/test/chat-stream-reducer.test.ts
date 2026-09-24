import { describe, expect, it } from "bun:test";
import {
  chatStreamAssistantMessage,
  createChatStreamState,
  reduceChatStreamChunk,
} from "../src/react/chat-stream-reducer.ts";

const initial = () =>
  createChatStreamState({
    pendingApprovals: [],
    runId: null,
    toolEvents: [],
  });

describe("chat stream reducer", () => {
  it("accumulates reasoning and segmented text", () => {
    const reasoning = reduceChatStreamChunk(initial(), {
      type: "reasoning-delta",
      payload: { text: "thinking" },
    });
    const started = reduceChatStreamChunk(reasoning.state, { type: "text-start" });
    const text = reduceChatStreamChunk(started.state, {
      type: "text-delta",
      payload: { text: "answer" },
    });

    expect(chatStreamAssistantMessage("assistant", text.state)).toEqual({
      id: "assistant",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "answer" },
      ],
    });
    expect(text.changes.status).toBe(false);
  });

  it("tracks tool lifecycle and ignores invalid progress events", () => {
    const call = reduceChatStreamChunk(initial(), {
      type: "tool-call",
      payload: { toolCallId: "tool-1", toolName: "ask_genie", args: {} },
    });
    const invalidProgress = reduceChatStreamChunk(call.state, {
      type: "tool-output",
      payload: { toolCallId: "tool-1", output: { unexpected: true } },
    });
    const result = reduceChatStreamChunk(invalidProgress.state, {
      type: "tool-result",
      payload: { toolCallId: "tool-1" },
    });

    expect(result.state.toolEvents).toEqual([
      { id: "tool-1", toolName: "ask_genie", status: "done" },
    ]);
  });

  it("deduplicates approval chunks by tool call id", () => {
    const chunk = {
      type: "tool-call-approval" as const,
      runId: "run-1",
      payload: { toolCallId: "tool-1", toolName: "send_email", args: { to: "a@b.c" } },
    };
    const first = reduceChatStreamChunk(initial(), chunk);
    const second = reduceChatStreamChunk(first.state, chunk);

    expect(second.state.pendingApprovals).toHaveLength(1);
    expect(second.changes.pendingApprovals).toBe(false);
  });

  it("requires a resumable run id for live approvals", () => {
    const missingRun = reduceChatStreamChunk(initial(), {
      type: "tool-call-approval",
      payload: { toolCallId: "tool-1", toolName: "send_email", args: {} },
    });
    const priorRun = reduceChatStreamChunk(
      { ...initial(), runId: "run-1" },
      {
        type: "tool-call-approval",
        payload: { toolCallId: "tool-1", toolName: "send_email", args: {} },
      },
    );

    expect(missingRun.state.pendingApprovals).toEqual([]);
    expect(missingRun.changes.pendingApprovals).toBe(false);
    expect(priorRun.state.pendingApprovals).toEqual([
      {
        toolCallId: "tool-1",
        toolName: "send_email",
        runId: "run-1",
        input: {},
      },
    ]);
  });

  it("ignores unknown events and surfaces stream errors", () => {
    const unknown = reduceChatStreamChunk(initial(), {
      type: "unknown",
      eventType: "step-finish",
      payload: {},
    });
    const failure = reduceChatStreamChunk(unknown.state, {
      type: "error",
      payload: { message: "upstream failed" },
    });

    expect(unknown.state).toEqual(initial());
    expect(failure.error).toBe("upstream failed");
  });

  it("surfaces messages from object-valued stream errors", () => {
    const failure = reduceChatStreamChunk(initial(), {
      type: "error",
      payload: {
        error: {
          message: "Genie turn failed",
          code: "GENIE_ERROR",
        },
      },
    });

    expect(failure.error).toBe("Genie turn failed");
  });
});
