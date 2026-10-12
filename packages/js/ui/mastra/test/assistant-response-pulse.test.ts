import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AssistantResponsePulse,
  shouldShowAssistantResponsePulse,
} from "../src/react/_assistant-response-pulse.tsx";

describe("AssistantResponsePulse", () => {
  it("renders a compact accessible reduced-motion-safe progress affordance", () => {
    const html = renderToStaticMarkup(createElement(AssistantResponsePulse));

    assert.match(html, /role="status"/);
    assert.match(html, /Response in progress/);
    assert.match(html, /animate-pulse/);
    assert.match(html, /motion-reduce:animate-none/);
  });

  it("shows only for the latest active assistant response with visible content", () => {
    assert.equal(shouldShowAssistantResponsePulse(true, "submitted", true), true);
    assert.equal(shouldShowAssistantResponsePulse(true, "streaming", true), true);
    assert.equal(shouldShowAssistantResponsePulse(true, "streaming", false), false);
    assert.equal(shouldShowAssistantResponsePulse(false, "streaming", true), false);
    assert.equal(shouldShowAssistantResponsePulse(true, "ready", true), false);
    assert.equal(shouldShowAssistantResponsePulse(true, "error", true), false);
  });
});
