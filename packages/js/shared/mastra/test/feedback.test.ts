import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FeedbackModeOptionSchema, MastraFeedbackRequestSchema } from "../src/feedback.ts";

describe("Mastra feedback contracts", () => {
  it("accepts only explicit feedback mode options", () => {
    assert.equal(FeedbackModeOptionSchema.parse("auto"), "auto");
    assert.throws(() => FeedbackModeOptionSchema.parse(true));
  });

  it("validates Genie rating, request, and comment", () => {
    assert.deepEqual(
      MastraFeedbackRequestSchema.parse({
        mode: "genie",
        spaceId: "space-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        rating: "POSITIVE",
        request: "What were sales?",
        comment: "Accurate.",
      }),
      {
        mode: "genie",
        spaceId: "space-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        rating: "POSITIVE",
        request: "What were sales?",
        comment: "Accurate.",
      },
    );
  });
});
