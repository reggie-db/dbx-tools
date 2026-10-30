import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AssistantBubble } from "../src/react/bubbles.tsx";

describe("thoughts disclosure", () => {
  it("uses the shared activity pill without nested detail chrome", () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "reasoning", text: "Checking the available evidence." }],
    } as UIMessage;

    const html = renderToStaticMarkup(
      createElement(AssistantBubble, {
        message,
        isLast: false,
        status: "ready",
      }),
    );

    assert.match(html, /rounded-md border border-border\/40 bg-background\/30 px-2 py-1/);
    assert.match(html, /lucide-chevron-down/);
    assert.match(html, />Thoughts</);
    assert.doesNotMatch(html, /border-l-2/);
    assert.doesNotMatch(html, />Request</);
    assert.doesNotMatch(html, />Response</);
  });

  it("compacts a continuation to the same gap used between activity pills", () => {
    const message = {
      id: "assistant-2",
      role: "assistant",
      parts: [{ type: "reasoning", text: "Comparing the two results." }],
    } as UIMessage;

    const html = renderToStaticMarkup(
      createElement(AssistantBubble, {
        message,
        isLast: false,
        status: "ready",
        continuation: true,
      }),
    );

    assert.match(html, /-mt-1\.5/);
  });
});
