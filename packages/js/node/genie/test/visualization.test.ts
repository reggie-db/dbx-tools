import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";
import { genieVisualizationDownloadPath } from "@dbx-tools/shared-genie";
import sharp from "sharp";
import { downloadGenieVisualization } from "../src/visualization.ts";

const input = {
  space_id: "space/1",
  conversation_id: "conversation-1",
  message_id: "message-1",
  attachment_id: "viz-1",
};
const png = await sharp({
  create: {
    width: 3,
    height: 2,
    channels: 4,
    background: { r: 35, g: 80, b: 160, alpha: 1 },
  },
})
  .png()
  .toBuffer();

describe("downloadGenieVisualization", () => {
  it("uses SDK raw mode and returns a four-times larger sharpened PNG", async () => {
    let received: Parameters<WorkspaceClient["apiClient"]["request"]>[0] | undefined;
    const client = {
      apiClient: {
        request: async (request: NonNullable<typeof received>) => {
          received = request;
          return { "content-type": "image/png", contents: new Response(png).body };
        },
      },
    } as unknown as WorkspaceClient;
    const bytes = await downloadGenieVisualization(input, { workspaceClient: client });
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, 12);
    assert.equal(metadata.height, 8);
    assert.notDeepEqual(bytes, png);
    assert.equal(received?.path, genieVisualizationDownloadPath(input));
    assert.equal(received?.path.includes("space%2F1"), true);
    assert.equal(received?.method, "GET");
    assert.equal(received?.raw, true);
    assert.equal(received?.headers.get("accept"), "image/png");
    assert.deepEqual(received?.responseHeaders, ["content-type"]);
  });

  it("cancels non-image bodies rather than returning JSON or SVG as PNG", async () => {
    let cancelled = false;
    const client = {
      apiClient: {
        request: async () => ({
          "content-type": "application/json",
          contents: new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        }),
      },
    } as unknown as WorkspaceClient;
    await assert.rejects(
      downloadGenieVisualization(input, { workspaceClient: client }),
      /did not return a PNG/,
    );
    assert.equal(cancelled, true);
  });

  it("rejects an invalid PNG signature and a missing binary body", async () => {
    for (const contents of [new Response("not an image").body, undefined]) {
      const client = {
        apiClient: { request: async () => ({ "content-type": "image/png", contents }) },
      } as unknown as WorkspaceClient;
      await assert.rejects(downloadGenieVisualization(input, { workspaceClient: client }), /PNG/);
    }
  });

  it("preserves upstream permission and expired-attachment errors", async () => {
    for (const status of [403, 404]) {
      const failure = Object.assign(new Error("Not accessible"), { status });
      const client = {
        apiClient: {
          request: async () => {
            throw failure;
          },
        },
      } as unknown as WorkspaceClient;
      await assert.rejects(
        downloadGenieVisualization(input, { workspaceClient: client }),
        (error) => error === failure,
      );
    }
  });

  it("passes cancellation to the SDK without changing authentication", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = {
      apiClient: {
        request: async (
          _request: unknown,
          context: { cancellationToken: { isCancellationRequested: boolean } },
        ) => {
          assert.equal(context.cancellationToken.isCancellationRequested, true);
          throw new DOMException("Aborted", "AbortError");
        },
      },
    } as unknown as WorkspaceClient;
    await assert.rejects(
      downloadGenieVisualization(input, { workspaceClient: client, context: controller.signal }),
      { name: "AbortError" },
    );
  });
});
