import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";

import { mergeToolEvents, toolEventsFromParts } from "../src/support/tool-events.ts";

describe("native persisted tool events", () => {
  it("projects complete native dynamic-tool input and output", () => {
    const input = { storeId: "store-1" };
    const output = { rows: Array.from({ length: 500 }, (_, index) => ({ index })) };
    const parts: UIMessage["parts"] = [
      {
        type: "dynamic-tool",
        toolCallId: "tool-1",
        toolName: "lookup_store",
        state: "output-available",
        input,
        output,
      },
    ];

    assert.deepEqual(toolEventsFromParts(parts), [
      {
        id: "tool-1",
        toolName: "lookup_store",
        status: "done",
        input,
        output,
      },
    ]);
  });

  it("merges live progress over the persisted native event", () => {
    const persisted = [
      {
        id: "tool-1",
        toolName: "lookup_store",
        status: "done" as const,
        input: { storeId: "store-1" },
        output: { ok: true },
      },
    ];
    const progress = [{ type: "started" as const, content: "Looking up store" }];

    assert.deepEqual(
      mergeToolEvents(persisted, [
        {
          id: "tool-1",
          toolName: "lookup_store",
          status: "done",
          progress,
        },
      ]),
      [{ ...persisted[0], progress }],
    );
  });
});
