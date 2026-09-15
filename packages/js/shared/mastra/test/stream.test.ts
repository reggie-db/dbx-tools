import { describe, expect, it } from "bun:test";
import { MastraStreamChunkSchema } from "../src/stream.ts";

describe("MastraStreamChunkSchema", () => {
  it("parses known chunks with their typed payload", () => {
    expect(
      MastraStreamChunkSchema.parse({
        type: "text-delta",
        runId: "run-1",
        payload: { text: "hello" },
      }),
    ).toEqual({
      type: "text-delta",
      runId: "run-1",
      payload: { text: "hello" },
    });
  });

  it("rejects malformed payloads for known event names", () => {
    expect(() =>
      MastraStreamChunkSchema.parse({
        type: "tool-call",
        payload: { toolName: "ask_genie" },
      }),
    ).toThrow();
  });

  it("normalizes future event names to an explicit unknown variant", () => {
    expect(
      MastraStreamChunkSchema.parse({
        type: "step-finish",
        runId: "run-2",
        payload: { reason: "stop" },
      }),
    ).toEqual({
      type: "unknown",
      eventType: "step-finish",
      runId: "run-2",
      payload: { reason: "stop" },
    });
  });
});
