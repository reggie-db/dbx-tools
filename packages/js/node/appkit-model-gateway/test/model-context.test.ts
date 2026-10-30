import { strict as assert } from "node:assert";
import { describe, it } from "vitest";

import { normalizeModelContext } from "../src/model-context.ts";

describe("normalizeModelContext", () => {
  it("normalizes strings, JSON strings, task objects, and Responses input", async () => {
    assert.equal((await normalizeModelContext("Explain the result")).task, "Explain the result");
    assert.match(
      (
        await normalizeModelContext(
          JSON.stringify({ messages: [{ role: "user", content: "Compare the models" }] }),
        )
      ).task,
      /Compare the models/,
    );
    assert.equal(
      (await normalizeModelContext({ request: { question: "Summarize the report" } })).task,
      "Summarize the report",
    );
    assert.match(
      (
        await normalizeModelContext({
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Refactor the parser" }],
            },
          ],
        })
      ).task,
      /Refactor the parser/,
    );
  });

  it("uses AI SDK UI messages and removes reasoning and tool payloads", async () => {
    const context = await normalizeModelContext([
      { id: "1", role: "user", parts: [{ type: "text", text: "Find the regression" }] },
      {
        id: "2",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "private chain" },
          { type: "text", text: "The regression is in parsing." },
          {
            type: "dynamic-tool",
            toolName: "shell",
            toolCallId: "call-1",
            state: "output-available",
            input: { authorization: "secret" },
            output: "sensitive tool output",
          },
        ],
      },
      { id: "3", role: "user", parts: [{ type: "text", text: "How should we fix it?" }] },
    ]);

    assert.match(context.task, /Find the regression/);
    assert.match(context.task, /How should we fix it/);
    assert.equal(context.task.includes("private chain"), false);
    assert.equal(context.task.includes("secret"), false);
    assert.equal(context.task.includes("sensitive tool output"), false);
  });

  it("limits tokens and ignores credential-shaped fields", async () => {
    const context = await normalizeModelContext(
      {
        prompt: "word ".repeat(500),
        metadata: { note: "exclude-metadata" },
        tools: [{ arguments: "exclude-arguments" }],
        authorization: "exclude-authorization",
      },
      { tokenLimit: 32 },
    );

    assert.ok(context.tokenCount <= 32);
    assert.equal(context.task.includes("exclude-"), false);
  });

  it("can retain tool output when requested", async () => {
    const context = await normalizeModelContext(
      [
        { role: "user", content: "Inspect the result" },
        { role: "tool", content: "Useful tool result" },
      ],
      { removeNonUsefulMessages: false },
    );
    assert.equal(context.events.some((event) => event.text === "Useful tool result"), true);
  });
});
