import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
} from "@databricks/appkit/testing";

import { debugCaptureEnabled } from "../src/appkit.ts";
import { DebugCapturePlugin } from "../src/debug/plugin.ts";

function responseJson(response: ReturnType<typeof createMockResponse>): unknown {
  return response.json.mock.calls[0]?.[0];
}

describe("AppKit browser debug capture", () => {
  it("enables auto mode only for the development Node environment", () => {
    assert.equal(debugCaptureEnabled(undefined, "development"), true);
    assert.equal(debugCaptureEnabled("auto", "production"), false);
    assert.equal(debugCaptureEnabled(true, "production"), true);
    assert.equal(debugCaptureEnabled(false, "development"), false);
  });

  it("registers one bounded capture route and publishes its base path", () => {
    const plugin = new DebugCapturePlugin({});
    const { router, handlers } = createMockRouter();

    plugin.injectRoutes(router);

    assert.deepEqual(Object.keys(handlers), ["POST:/captures"]);
    assert.deepEqual(plugin.clientConfig(), { basePath: "/api/debug-capture" });
    assert.deepEqual(plugin.getEndpoints(), { captures: "/api/debug-capture/captures" });
  });

  it("writes start, event, and stop records to one JSONL capture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dbx-tools-debug-capture-test-"));
    try {
      const plugin = new DebugCapturePlugin({ directory });
      const { router, getHandler } = createMockRouter();
      plugin.injectRoutes(router);
      const handler = getHandler("post", "/captures");

      const startResponse = createMockResponse();
      await handler(
        createMockRequest({
          body: { action: "start", metadata: { application: "test" } },
          headers: { "user-agent": "test-browser" },
        }),
        startResponse,
      );
      const captureId = (responseJson(startResponse) as { captureId: string }).captureId;

      await handler(
        createMockRequest({
          body: {
            action: "append",
            captureId,
            events: [{ at: 1, sequence: 0, type: "browser-focusin", data: {} }],
          },
        }),
        createMockResponse(),
      );
      await handler(
        createMockRequest({
          body: {
            action: "stop",
            captureId,
            events: [{ at: 2, sequence: 1, type: "capture-stop-requested", data: {} }],
          },
        }),
        createMockResponse(),
      );

      const records = (await readFile(join(directory, `${captureId}.jsonl`), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; metadata?: Record<string, unknown> });
      assert.deepEqual(
        records.map((record) => record.kind),
        ["capture-start", "event", "event", "capture-stop"],
      );
      assert.deepEqual(records[0]?.metadata, {
        application: "test",
        userAgent: "test-browser",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid route bodies without creating a capture", async () => {
    const plugin = new DebugCapturePlugin({});
    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);
    const response = createMockResponse();

    await getHandler("post", "/captures")(
      createMockRequest({ body: { action: "start", metadata: {}, extra: true } }),
      response,
    );

    assert.deepEqual(response.status.mock.calls[0], [400]);
    assert.deepEqual(responseJson(response), { error: "Invalid debug capture request." });
  });
});
