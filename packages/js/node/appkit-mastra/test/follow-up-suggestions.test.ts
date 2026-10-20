import { describe, expect, test } from "bun:test";
import { FOLLOW_UP_SUGGESTIONS_PART_TYPE } from "@dbx-tools/shared-mastra/wire";
import { MessageList } from "@mastra/core/agent/message-list";
import { RequestContext } from "@mastra/core/request-context";

import type { MastraPluginConfig } from "../src/config.ts";
import {
  buildFollowUpSuggestionsProcessor,
  buildFollowUpSuggestionsTransform,
  FOLLOW_UP_NATIVE_QUESTIONS_KEY,
  FOLLOW_UP_RUN_ID_KEY,
  FOLLOW_UP_USER_TEXT_KEY,
  resolveFollowUpSuggestionsConfig,
  suggestFollowUps,
  type SuggestFollowUpsOptions,
} from "../src/follow-up-suggestions.ts";

describe("follow-up suggestion config", () => {
  test("defaults off and resolves the public shorthand modes", () => {
    expect(resolveFollowUpSuggestionsConfig(undefined)).toBeUndefined();
    expect(resolveFollowUpSuggestionsConfig(false)).toBeUndefined();
    expect(resolveFollowUpSuggestionsConfig(true)).toMatchObject({ mode: "auto", limit: 3 });
    expect(resolveFollowUpSuggestionsConfig("genie")).toMatchObject({ mode: "genie", limit: 3 });
    expect(resolveFollowUpSuggestionsConfig("generated")).toMatchObject({
      mode: "generated",
      limit: 3,
    });
  });

  test("accepts a custom limit up to ten", () => {
    expect(resolveFollowUpSuggestionsConfig({ mode: true, limit: 10 })?.limit).toBe(10);
    expect(resolveFollowUpSuggestionsConfig({ mode: "generated", limit: 50 })?.limit).toBe(10);
  });
});

describe("native Mastra output integration", () => {
  test("auto persists and streams generated questions after considering Genie", async () => {
    const config = { followUpSuggestions: true } satisfies MastraPluginConfig;
    const requestContext = new RequestContext();
    requestContext.setRaw(FOLLOW_UP_RUN_ID_KEY, "run-1");
    requestContext.setRaw(FOLLOW_UP_USER_TEXT_KEY, "How did revenue change?");
    requestContext.setRaw(FOLLOW_UP_NATIVE_QUESTIONS_KEY, ["Show revenue by region"]);
    let received: SuggestFollowUpsOptions | undefined;
    const messageList = new MessageList().add(
      {
        id: "answer-1",
        role: "assistant",
        parts: [{ type: "text", text: "Revenue increased." }],
      },
      "response",
    );
    const processor = buildFollowUpSuggestionsProcessor(config, async (_config, options) => {
      received = options;
      return [
        "Would you like to change the categories or values?",
        "Should the chart be sorted in ascending or descending order?",
        "Which category has the highest value?",
        "How large is the gap between the highest and lowest categories?",
      ];
    });

    await processor?.processOutputResult?.({
      result: {
        text: "Revenue increased.",
        finishReason: "stop",
        steps: [
          {
            toolCalls: [
              {
                toolName: "render_data",
                args: {
                  data: [
                    { category: "North", value: 42 },
                    { category: "South", value: 18 },
                  ],
                },
              },
              {
                payload: {
                  toolName: "get_statement",
                  args: {
                    statement_id: "statement-1",
                  },
                },
              },
            ],
            toolResults: [
              {
                toolName: "render_data",
                result: { chartId: "chart-1" },
              },
              {
                payload: {
                  toolName: "get_statement",
                  result: { rowCount: 2 },
                },
              },
            ],
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
      messageList,
      requestContext,
    } as never);
    const persistedParts = messageList.get.response.db().at(-1)?.content.parts;
    const chunks: unknown[] = [];
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "finish" });
        controller.close();
      },
    }).pipeThrough(buildFollowUpSuggestionsTransform("run-1")());
    for await (const chunk of stream) chunks.push(chunk);

    expect(received?.nativeQuestions).toEqual(["Show revenue by region"]);
    expect(received?.turnContext).toContain('"tool":"render_data"');
    expect(received?.turnContext).toContain('"category":"North"');
    expect(received?.turnContext).toContain('"tool":"get_statement"');
    expect(
      persistedParts?.find((part) => part.type === FOLLOW_UP_SUGGESTIONS_PART_TYPE),
    ).toMatchObject({
      type: FOLLOW_UP_SUGGESTIONS_PART_TYPE,
      data: {
        questions: [
          "Which category has the highest value?",
          "How large is the gap between the highest and lowest categories?",
        ],
        source: "model",
      },
    });
    expect(chunks).toEqual([
      {
        type: FOLLOW_UP_SUGGESTIONS_PART_TYPE,
        data: {
          questions: [
            "Which category has the highest value?",
            "How large is the gap between the highest and lowest categories?",
          ],
          source: "model",
        },
      },
      { type: "finish" },
    ]);
  });

  test("generated mode ignores native questions and failures stay open", async () => {
    const config = { followUpSuggestions: "generated" } satisfies MastraPluginConfig;
    const requestContext = new RequestContext();
    requestContext.setRaw(FOLLOW_UP_USER_TEXT_KEY, "How did revenue change?");
    requestContext.setRaw(FOLLOW_UP_NATIVE_QUESTIONS_KEY, ["Show revenue by region"]);
    let received: SuggestFollowUpsOptions | undefined;
    const messageList = new MessageList().add(
      {
        id: "answer-1",
        role: "assistant",
        parts: [{ type: "text", text: "Revenue increased." }],
      },
      "response",
    );
    const processor = buildFollowUpSuggestionsProcessor(config, async (_config, options) => {
      received = options;
      return [];
    });

    await expect(
      processor?.processOutputResult?.({
        result: {
          text: "Revenue increased.",
          finishReason: "stop",
          steps: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
        messageList,
        requestContext,
      } as never),
    ).resolves.toBe(messageList);
    expect(received?.nativeQuestions).toBeUndefined();
    expect(
      messageList.get.response
        .db()
        .at(-1)
        ?.content.parts.some((part) => {
          return part.type === FOLLOW_UP_SUGGESTIONS_PART_TYPE;
        }),
    ).toBe(false);
  });

  test("Genie-only policy does not construct a generated processor", async () => {
    const config = { followUpSuggestions: "genie" } satisfies MastraPluginConfig;
    expect(buildFollowUpSuggestionsProcessor(config)).toBeUndefined();
    await expect(
      suggestFollowUps(config, { userText: "Question", answer: "Answer" }),
    ).resolves.toEqual([]);
  });
});
