import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEBUG_CAPTURE_DEFAULT_BASE_PATH,
  DebugCaptureRequestSchema,
  debugCaptureRoute,
} from "../src/debug/contracts.ts";

describe("browser debug capture contracts", () => {
  it("builds the capture route from the published AppKit base path", () => {
    assert.equal(debugCaptureRoute(), `${DEBUG_CAPTURE_DEFAULT_BASE_PATH}/captures`);
    assert.equal(debugCaptureRoute("/api/custom/"), "/api/custom/captures");
  });

  it("accepts bounded event batches and rejects unknown fields", () => {
    assert.equal(
      DebugCaptureRequestSchema.safeParse({
        action: "append",
        captureId: "vp-mh123abc-0123abcd",
        events: [{ at: 1, sequence: 0, type: "browser-scroll", data: { scrollY: 12 } }],
      }).success,
      true,
    );
    assert.equal(
      DebugCaptureRequestSchema.safeParse({
        action: "start",
        metadata: {},
        unexpected: true,
      }).success,
      false,
    );
  });
});
