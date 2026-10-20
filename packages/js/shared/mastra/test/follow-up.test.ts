import { describe, expect, test } from "bun:test";

import {
  FollowUpSuggestionModeSchema,
  FollowUpSuggestionsPartDataSchema,
  MastraClientConfigSchema,
} from "../src/wire.ts";

describe("follow-up suggestion wire contracts", () => {
  test("defaults disabled with a three-question limit", () => {
    const config = MastraClientConfigSchema.parse({
      basePath: "/api/mastra",
      defaultAgent: "support",
      agents: ["support"],
    });

    expect(config.followUpSuggestions).toBe("none");
    expect(config.followUpSuggestionLimit).toBe(3);
  });

  test("accepts only the published source policies", () => {
    expect(FollowUpSuggestionModeSchema.options).toEqual(["none", "genie", "generated", "auto"]);
  });

  test("validates persisted source data up to ten questions", () => {
    const questions = Array.from({ length: 10 }, (_, index) => `Question ${index + 1}?`);
    expect(FollowUpSuggestionsPartDataSchema.parse({ questions, source: "model" })).toEqual({
      questions,
      source: "model",
    });
    expect(() =>
      FollowUpSuggestionsPartDataSchema.parse({
        questions: [...questions, "Question 11?"],
        source: "genie",
      }),
    ).toThrow();
  });
});
