import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chatContentToText,
  UNSUPPORTED_CHAT_FIELDS,
  stripUnsupportedChatFields,
} from "../src/openai-chat.ts";

describe("OpenAI chat helpers", () => {
  describe("chatContentToText", () => {
    it("passes a string through", () => {
      assert.equal(chatContentToText("hello"), "hello");
    });

    it("flattens supported structured parts with a separator", () => {
      assert.equal(
        chatContentToText(
          [
            { type: "text", text: "one" },
            { type: "image", url: "x" },
            { type: "output_text", text: "two" },
          ],
          { separator: "|" },
        ),
        "one|two",
      );
    });

    it("filters structured parts by type", () => {
      assert.equal(
        chatContentToText(
          [
            { type: "input_text", text: "in" },
            { type: "output_text", text: "out" },
          ],
          { types: ["output_text"] },
        ),
        "out",
      );
    });
  });

  describe("stripUnsupportedChatFields", () => {
    it("reports built-in unsupported fields", () => {
      assert.deepEqual(stripUnsupportedChatFields({ store: true, metadata: {}, messages: [] }), [
        "store",
        "metadata",
      ]);
    });

    it("reports caller-supplied unsupported fields", () => {
      assert.deepEqual(stripUnsupportedChatFields({ messages: [], custom: true }, ["custom"]), [
        "custom",
      ]);
    });
  });
});

describe("stripUnsupportedChatFields TypeScript mutation", () => {
  it("removes built-in fields from the original body", () => {
    const body: Record<string, unknown> = {
      model: "databricks-claude-opus-4-8",
      messages: [],
      parallel_tool_calls: false,
      store: false,
      metadata: null,
    };
    stripUnsupportedChatFields(body);
    assert.deepEqual(body, { model: "databricks-claude-opus-4-8", messages: [] });
  });

  it("leaves a supported body untouched", () => {
    const body: Record<string, unknown> = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      tools: [],
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 64,
    };
    const before = structuredClone(body);
    stripUnsupportedChatFields(body);
    assert.deepEqual(body, before);
  });

  it("removes caller-supplied extras and covers every advertised field", () => {
    const body: Record<string, unknown> = {
      ...Object.fromEntries(UNSUPPORTED_CHAT_FIELDS.map((field) => [field, 1])),
      future_field: 1,
      keep: 2,
    };
    stripUnsupportedChatFields(body, ["future_field"]);
    assert.deepEqual(body, { keep: 2 });
  });
});
