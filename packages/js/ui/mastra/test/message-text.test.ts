import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";

import { messageText } from "../src/support/export.ts";
import { messageTextFromParts } from "../src/support/message-text.ts";

describe("message text", () => {
  it("concatenates adjacent text parts exactly", () => {
    const parts: UIMessage["parts"] = [
      { type: "text", text: "store." },
      { type: "text", text: "250 documents" },
    ];

    assert.equal(messageTextFromParts(parts), "store.250 documents");
  });

  it("separates text parts split by a tool call", () => {
    const parts: UIMessage["parts"] = [
      { type: "text", text: "I'll search for documents related to a store." },
      {
        type: "dynamic-tool",
        toolCallId: "tool-1",
        toolName: "search_legal_documents",
        state: "output-available",
        input: { query: "store" },
        output: { total: 250 },
      },
      { type: "text", text: '250 documents match "store".' },
    ];

    assert.equal(
      messageTextFromParts(parts),
      'I\'ll search for documents related to a store.\n\n250 documents match "store".',
    );
  });

  it("does not duplicate existing boundary whitespace", () => {
    const trailingWhitespace: UIMessage["parts"] = [
      { type: "text", text: "Checking the store.\n" },
      {
        type: "dynamic-tool",
        toolCallId: "tool-1",
        toolName: "search_legal_documents",
        state: "output-available",
        input: { query: "store" },
        output: { total: 250 },
      },
      { type: "text", text: "250 documents match." },
    ];
    const leadingWhitespace: UIMessage["parts"] = [
      { type: "text", text: "Checking the store." },
      {
        type: "dynamic-tool",
        toolCallId: "tool-2",
        toolName: "search_legal_documents",
        state: "output-available",
        input: { query: "store" },
        output: { total: 250 },
      },
      { type: "text", text: "\n250 documents match." },
    ];

    assert.equal(
      messageTextFromParts(trailingWhitespace),
      "Checking the store.\n250 documents match.",
    );
    assert.equal(
      messageTextFromParts(leadingWhitespace),
      "Checking the store.\n250 documents match.",
    );
  });

  it("uses the same boundaries for copied and exported message text", () => {
    const message: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "text", text: "Checking the store." },
        {
          type: "dynamic-tool",
          toolCallId: "tool-1",
          toolName: "search_legal_documents",
          state: "output-available",
          input: { query: "store" },
          output: { total: 250 },
        },
        { type: "text", text: "250 documents match." },
      ],
    };

    assert.equal(messageText(message), "Checking the store.\n\n250 documents match.");
  });
});
