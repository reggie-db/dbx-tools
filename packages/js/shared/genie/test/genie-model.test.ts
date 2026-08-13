/** Regression tests for Genie wire-schema compatibility. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GenieMessageSchema,
  GenieTextAttachmentSchema,
} from "../src/genie-model.ts";

describe("GenieTextAttachmentSchema", () => {
  it("accepts answer purposes emitted by the live Genie API", () => {
    const attachment = GenieTextAttachmentSchema.parse({
      content: "The weekly trend is complete.",
      purpose: "TEXT_ATTACHMENT_PURPOSE_ANSWER",
    });

    assert.equal(attachment.purpose, "TEXT_ATTACHMENT_PURPOSE_ANSWER");
  });

  it("accepts future string purposes without weakening the field type", () => {
    assert.equal(
      GenieTextAttachmentSchema.parse({ purpose: "NEW_SERVER_PURPOSE" }).purpose,
      "NEW_SERVER_PURPOSE",
    );
    assert.throws(() => GenieTextAttachmentSchema.parse({ purpose: 42 }));
  });
});

describe("GenieMessageSchema", () => {
  it("preserves query results when an answer text attachment is present", () => {
    const message = GenieMessageSchema.parse({
      content: "Weekly trend",
      conversation_id: "conversation-1",
      id: "message-1",
      message_id: "message-1",
      space_id: "space-1",
      attachments: [
        {
          attachment_id: "query-1",
          query: {
            query: "SELECT 1",
            statement_id: "statement-1",
          },
        },
        {
          text: {
            content: "Here is the weekly trend.",
            purpose: "TEXT_ATTACHMENT_PURPOSE_ANSWER",
          },
        },
      ],
    });

    assert.equal(message.attachments?.[0]?.query?.statement_id, "statement-1");
    assert.equal(
      message.attachments?.[1]?.text?.purpose,
      "TEXT_ATTACHMENT_PURPOSE_ANSWER",
    );
  });
});
