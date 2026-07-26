import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UNSUPPORTED_CHAT_FIELDS,
  chatContentToText,
  stripUnsupportedChatFields,
} from "../src/openai-chat";

describe("chatContentToText", () => {
  it("passes a string through and flattens typed parts", () => {
    assert.equal(chatContentToText("hello"), "hello");
    assert.equal(
      chatContentToText([{ type: "input_text", text: "a" }, { type: "output_text", text: "b" }]),
      "ab",
    );
  });

  it("honors a separator and a type filter", () => {
    const content = [
      { type: "text", text: "one" },
      { type: "thinking", text: "hidden" },
      { type: "text", text: "two" },
    ];
    assert.equal(chatContentToText(content, { separator: "\n\n", types: ["text"] }), "one\n\ntwo");
  });

  it("yields empty string for anything it can't read", () => {
    assert.equal(chatContentToText(null), "");
    assert.equal(chatContentToText(undefined), "");
    assert.equal(chatContentToText([{ type: "image_url" }]), "");
  });
});

describe("stripUnsupportedChatFields", () => {
  it("drops parallel_tool_calls, the field Databricks rejects outright", () => {
    const body: Record<string, unknown> = {
      model: "databricks-claude-opus-4-8",
      messages: [],
      parallel_tool_calls: false,
    };
    assert.deepEqual(stripUnsupportedChatFields(body), ["parallel_tool_calls"]);
    assert.deepEqual(body, { model: "databricks-claude-opus-4-8", messages: [] });
  });

  it("drops a field present with a falsy or null value", () => {
    const body: Record<string, unknown> = { store: false, metadata: null };
    assert.deepEqual(stripUnsupportedChatFields(body).sort(), ["metadata", "store"]);
    assert.deepEqual(body, {});
  });

  it("leaves a supported body untouched and reports nothing dropped", () => {
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
    assert.deepEqual(stripUnsupportedChatFields(body), []);
    assert.deepEqual(body, before);
  });

  it("drops caller-supplied extra fields alongside the built-in list", () => {
    const body: Record<string, unknown> = { store: true, future_field: 1, keep: 2 };
    assert.deepEqual(stripUnsupportedChatFields(body, ["future_field"]), [
      "store",
      "future_field",
    ]);
    assert.deepEqual(body, { keep: 2 });
  });

  it("covers every name it advertises", () => {
    const body = Object.fromEntries(UNSUPPORTED_CHAT_FIELDS.map((field) => [field, 1]));
    assert.deepEqual(stripUnsupportedChatFields(body), [...UNSUPPORTED_CHAT_FIELDS]);
    assert.deepEqual(body, {});
  });
});
