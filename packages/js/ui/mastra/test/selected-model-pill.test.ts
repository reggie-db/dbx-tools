import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MODEL_ROUTE_PART_TYPE, MODEL_USAGE_PART_TYPE } from "@dbx-tools/shared-mastra";
import type { UIMessage } from "ai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SelectedModelPill,
  normalizeChatMetrics,
  selectedModelActivity,
  selectedModelRoute,
  selectedModelTurnMetrics,
} from "../src/react/selected-model-pill.tsx";

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
    assert.equal(selectedModelActivity(message)?.usage?.usage.totalTokens, 10);
  });

  it("shows only the friendly name in the row and exposes the endpoint as hover text", () => {
    const html = renderToStaticMarkup(
      createElement(SelectedModelPill, {
        activity: {
          route: {
            model: "databricks-claude-sonnet-4-6",
            selection: "ai-decide",
          },
        },
        message: {},
      }),
    );

    assert.match(html, /Claude Sonnet 4\.6/);
    assert.match(html, /aria-label="Claude Sonnet 4\.6: databricks-claude-sonnet-4-6"/);
    assert.doesNotMatch(html, />databricks-claude-sonnet-4-6</);
    assert.doesNotMatch(html, /aria-expanded/);
  });

  it("accepts one or many metrics and removes duplicates", () => {
    assert.deepEqual(normalizeChatMetrics("time"), ["time"]);
    assert.deepEqual(normalizeChatMetrics(["usd", "tokens", "usd"]), ["usd", "tokens"]);
    assert.deepEqual(normalizeChatMetrics(undefined), []);
  });

  it("uses the catalog-derived USD estimate without translating pricing", () => {
    assert.deepEqual(
      selectedModelTurnMetrics({
        parts: [
          {
            type: MODEL_USAGE_PART_TYPE,
            data: {
              model: "databricks-gpt-5-4",
              selection: "explicit",
              pricing: {
                unit: "per_million_tokens",
                rates: { short_context_input: 35.714, short_context_output: 214.286 },
              },
              usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
              estimatedCostDbu: 0.000714284,
              estimatedCostUsd: 0.00005,
            },
          },
        ],
      }),
      { tokens: 10, dbu: 0.000714284, usd: 0.00005 },
    );
  });
});
