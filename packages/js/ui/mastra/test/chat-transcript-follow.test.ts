import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TRANSCRIPT_FOLLOW_CANCEL_EVENTS } from "../src/react/chat-transcript.tsx";

describe("desktop transcript following", () => {
  it("only treats real scrolling gestures as candidates to stop following", () => {
    assert.deepEqual(TRANSCRIPT_FOLLOW_CANCEL_EVENTS, ["touchmove", "wheel"]);
    assert.equal(
      (TRANSCRIPT_FOLLOW_CANCEL_EVENTS as readonly string[]).includes("pointermove"),
      false,
    );
  });
});
