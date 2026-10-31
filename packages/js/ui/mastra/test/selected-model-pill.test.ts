import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MODEL_ROUTE_PART_TYPE, MODEL_USAGE_PART_TYPE } from "@dbx-tools/shared-mastra";
import type { UIMessage } from "ai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SelectedModelPill, selectedModelRoute } from "../src/react/selected-model-pill.tsx";

describe("selected model pill", () => {
  it("reads the route as soon as the route part arrives", () => {
    const message: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: MODEL_ROUTE_PART_TYPE,
          data: {
            model: "databricks-claude-sonnet-4-6",
            selection: "ai-decide",
          },
        },
      ],
    };

    assert.equal(selectedModelRoute(message)?.model, "databricks-claude-sonnet-4-6");
  });

  it("falls back to the persisted usage part", () => {
    const message: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: MODEL_USAGE_PART_TYPE,
          data: {
            model: "databricks-gpt-5-4",
            selection: "explicit",
            usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
          },
        },
      ],
    };

    assert.equal(selectedModelRoute(message)?.model, "databricks-gpt-5-4");
  });

  it("shows the friendly name and endpoint without a disclosure", () => {
    const html = renderToStaticMarkup(
      createElement(SelectedModelPill, {
        route: {
          model: "databricks-claude-sonnet-4-6",
          selection: "ai-decide",
        },
      }),
    );

    assert.match(html, /Claude Sonnet 4\.6/);
    assert.match(html, /databricks-claude-sonnet-4-6/);
    assert.doesNotMatch(html, /aria-expanded/);
  });
});
