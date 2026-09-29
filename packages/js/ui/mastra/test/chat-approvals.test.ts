import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveApprovalContinuation } from "../src/react/chat-approvals.ts";
import { createThreadSession } from "../src/support/thread-sessions.ts";

describe("approval continuation context", () => {
  it("uses the context captured by the approval run instead of the latest run", () => {
    const session = {
      ...createThreadSession(),
      assistantId: "assistant-new",
      runId: "run-new",
      runRequestContext: { storeId: "store-new" },
      runs: {
        "run-old": {
          assistantId: "assistant-old",
          requestContext: { storeId: "store-old" },
        },
        "run-new": {
          assistantId: "assistant-new",
          requestContext: { storeId: "store-new" },
        },
      },
    };

    assert.deepEqual(
      resolveApprovalContinuation(session, {
        approved: true,
        messageId: "assistant-old",
        runId: "run-old",
        toolCallId: "tool-old",
        toolName: "send_email",
        input: {},
      }),
      {
        assistantId: "assistant-old",
        runId: "run-old",
        requestContext: { storeId: "store-old" },
      },
    );
  });

  it("omits browser context when restoring a persisted run", () => {
    const session = createThreadSession();
    assert.deepEqual(
      resolveApprovalContinuation(session, {
        approved: false,
        messageId: "assistant-old",
        runId: "run-old",
        toolCallId: "tool-old",
        toolName: "send_email",
        input: {},
        reason: "Denied",
      }),
      {
        assistantId: "assistant-old",
        runId: "run-old",
        requestContext: undefined,
      },
    );
  });
});
