import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AssistantResponseSpinner,
  shouldShowAssistantResponseStatus,
} from "../src/react/_assistant-response-status.tsx";
import { AssistantBubble } from "../src/react/bubbles.tsx";
import { latestVisibleAssistantIndexInTurn } from "../src/react/chat-transcript.tsx";

describe("AssistantResponseSpinner", () => {
  it("renders a compact accessible spinner without visible status text", () => {
    const html = renderToStaticMarkup(createElement(AssistantResponseSpinner));

    assert.match(html, /role="status"/);
    assert.match(html, /Response in progress/);
    assert.match(html, /animate-spin/);
    assert.doesNotMatch(html, /animate-pulse/);
  });

  it("shows only for the latest active assistant response with visible content", () => {
    assert.equal(shouldShowAssistantResponseStatus(true, "submitted", true), true);
    assert.equal(shouldShowAssistantResponseStatus(true, "streaming", true), true);
    assert.equal(shouldShowAssistantResponseStatus(true, "streaming", false), false);
    assert.equal(shouldShowAssistantResponseStatus(false, "streaming", true), false);
    assert.equal(shouldShowAssistantResponseStatus(true, "finishing", true), true);
    assert.equal(shouldShowAssistantResponseStatus(true, "ready", true), false);
    assert.equal(shouldShowAssistantResponseStatus(true, "error", true), false);
  });

  it("places the active spinner directly after the last footer action", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantBubble, {
        message: {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Partial answer" }],
        },
        isLast: true,
        status: "streaming",
        onExport: () => undefined,
        mlflowTraceUrl: "https://example.com/mlflow/traces/tr-123",
      }),
    );

    const copyIndex = html.indexOf('aria-label="Copy"');
    const exportIndex = html.indexOf('aria-label="Export message"');
    const debugIndex = html.indexOf('aria-label="Open MLflow trace"');
    const statusIndex = html.indexOf("Response in progress");
    assert.ok(copyIndex >= 0 && copyIndex < statusIndex);
    assert.ok(exportIndex >= 0 && exportIndex < statusIndex);
    assert.ok(debugIndex >= 0 && debugIndex < statusIndex);
    assert.match(html, /Response in progress/);
    assert.doesNotMatch(html, /ml-auto|left-1\/2|-translate-x-1\/2/);
    assert.doesNotMatch(html, /Thinking\.\.\.|animate-pulse/);
  });

  it("keeps a tool-only spinner left in the same footer row", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantBubble, {
        message: {
          id: "assistant-1",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolCallId: "tool-1",
              toolName: "lookup_store",
              state: "input-available",
              input: {},
            },
          ],
        },
        isLast: true,
        status: "streaming",
      }),
    );

    assert.match(html, /Response in progress/);
    assert.doesNotMatch(html, /ml-auto|left-1\/2|-translate-x-1\/2/);
  });

  it("keeps finishing status on the visible response before a trailing empty assistant", () => {
    const messages = [
      { id: "user-1", role: "user" as const, parts: [{ type: "text" as const, text: "Hi" }] },
      {
        id: "assistant-1",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "Hello" }],
      },
      { id: "assistant-2", role: "assistant" as const, parts: [] },
    ];

    assert.equal(latestVisibleAssistantIndexInTurn(messages, {}), 1);
  });
});
