import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TextStreamPart, ToolSet } from "ai";

import { encodeGatewayStream } from "../src/protocols/encode.ts";

describe("gateway protocol streams", () => {
  it("emits a complete Responses SSE lifecycle", async () => {
    const body = encodeGatewayStream(
      "openai-responses",
      "databricks-gpt-test",
      parts([
        { type: "start" },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", text: "hello" },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "stop",
          totalUsage: usage(2, 1),
        },
      ]),
    );
    const text = await new Response(body).text();

    assert.match(text, /event: response\.created/);
    assert.match(text, /event: response\.in_progress/);
    assert.match(text, /event: response\.output_text\.delta/);
    assert.match(text, /"delta":"hello"/);
    assert.match(text, /"content":\[\{"type":"output_text","text":"hello"/);
    assert.match(text, /event: response\.completed/);
    assert.doesNotMatch(text, /data: \[DONE\]/);
  });

  it("preserves streamed tool argument deltas in Chat format", async () => {
    const body = encodeGatewayStream(
      "openai-chat",
      "databricks-gpt-test",
      parts([
        { type: "tool-input-start", id: "call-1", toolName: "lookup" },
        { type: "tool-input-delta", id: "call-1", delta: '{"q":' },
        { type: "tool-input-delta", id: "call-1", delta: '"model"}' },
        { type: "tool-input-end", id: "call-1" },
        {
          type: "finish",
          finishReason: "tool-calls",
          rawFinishReason: "tool_calls",
          totalUsage: usage(4, 3),
        },
      ]),
    );
    const text = await new Response(body).text();

    assert.match(text, /"name":"lookup"/);
    assert.match(text, /\{\\"q\\":/);
    assert.match(text, /"finish_reason":"tool_calls"/);
  });

  it("emits Anthropic content and terminal events", async () => {
    const body = encodeGatewayStream(
      "anthropic-messages",
      "databricks-claude-test",
      parts([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", text: "hello" },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "end_turn",
          totalUsage: usage(3, 2),
        },
      ]),
    );
    const text = await new Response(body).text();

    assert.match(text, /event: message_start/);
    assert.match(text, /event: content_block_delta/);
    assert.match(text, /event: message_stop/);
  });
});

async function* parts(
  values: Array<TextStreamPart<ToolSet>>,
): AsyncGenerator<TextStreamPart<ToolSet>> {
  yield* values;
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokens,
    outputTokenDetails: {
      textTokens: outputTokens,
      reasoningTokens: 0,
    },
    totalTokens: inputTokens + outputTokens,
  };
}
