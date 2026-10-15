import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sendGenieMessageFeedback } from "../src/feedback.ts";

describe("Genie message feedback", () => {
  it("posts rating and comment to the targeted Agent Mode message", async () => {
    const requests: unknown[] = [];
    const client = {
      apiClient: {
        request: async (request: unknown) => {
          requests.push(request);
          return {};
        },
      },
    };
    await sendGenieMessageFeedback(
      {
        space_id: "space-1",
        conversation_id: "conversation-1",
        message_id: "message-1",
        rating: "NEGATIVE",
        comment: "The answer missed the date filter.",
      },
      { workspaceClient: client as never },
    );
    assert.deepEqual(requests, [
      {
        path: "/api/2.0/genie/spaces/space-1/conversations/conversation-1/messages/message-1/feedback",
        method: "POST",
        payload: {
          rating: "NEGATIVE",
          comment: "The answer missed the date filter.",
        },
        headers: new Headers(),
        raw: false,
      },
    ]);
  });
});
