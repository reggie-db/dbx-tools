import { describe, expect, test } from "bun:test";
import { FOLLOW_UP_SUGGESTIONS_PART_TYPE } from "@dbx-tools/shared-mastra/wire";
import type { UIMessage } from "ai";

import { collectSuggestions } from "../src/react/suggestions.ts";
import type { ToolEvent } from "../src/react/types.ts";

const message: UIMessage = {
  id: "assistant-1",
  role: "assistant",
  parts: [
    { type: "text", text: "Revenue increased." },
    {
      type: FOLLOW_UP_SUGGESTIONS_PART_TYPE,
      data: {
        questions: ["Which stores led growth?", "How did margin change?"],
        source: "model",
      },
    },
  ],
};

const events: ToolEvent[] = [
  {
    id: "tool-1",
    toolName: "ask_genie",
    status: "done",
    progress: [
      {
        type: "suggested_questions",
        questions: ["Show revenue by region", "How did margin change this quarter?"],
      },
    ],
  },
];

describe("post-turn suggestions", () => {
  test("keeps follow-ups disabled by default", () => {
    expect(collectSuggestions(events, message, "none", 3)).toEqual([]);
  });

  test("selects only the configured source", () => {
    expect(collectSuggestions(events, message, "genie", 3)).toEqual([
      "Show revenue by region",
      "How did margin change this quarter?",
    ]);
    expect(collectSuggestions(events, message, "generated", 3)).toEqual([
      "Which stores led growth?",
      "How did margin change?",
    ]);
  });

  test("round-robins auto sources, dedupes, and honors the configured limit", () => {
    expect(collectSuggestions(events, message, "auto", 3)).toEqual([
      "Show revenue by region",
      "Which stores led growth?",
      "How did margin change this quarter?",
    ]);
  });
});
