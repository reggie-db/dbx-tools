import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";

import { excludeHttpTelemetryRequest } from "../src/telemetry.ts";

function request(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

describe("AppKit HTTP telemetry", () => {
  it("supports exact and prefix exclusions without matching sibling paths", () => {
    const options = { exclude: ["/healthz", "/sandbox/*"] } as const;

    assert.equal(excludeHttpTelemetryRequest(request("/healthz?full=true"), options), true);
    assert.equal(excludeHttpTelemetryRequest(request("/sandbox/service/socket"), options), true);
    assert.equal(excludeHttpTelemetryRequest(request("/sandbox"), options), false);
    assert.equal(excludeHttpTelemetryRequest(request("/sandboxes/service"), options), false);
    assert.equal(excludeHttpTelemetryRequest(request("/api/chat"), options), false);
  });

  it("combines path exclusions with a caller-owned filter", () => {
    assert.equal(
      excludeHttpTelemetryRequest(request("/events"), {
        filter: (incoming) => incoming.headers?.upgrade === "websocket",
      }),
      false,
    );
    assert.equal(
      excludeHttpTelemetryRequest(
        { url: "/events", headers: { upgrade: "websocket" } } as IncomingMessage,
        { filter: (incoming) => incoming.headers.upgrade === "websocket" },
      ),
      true,
    );
  });
});
