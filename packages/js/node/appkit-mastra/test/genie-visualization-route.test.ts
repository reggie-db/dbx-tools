import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getExecutionContext, type WorkspaceClient } from "@databricks/appkit";
import {
  createTestPluginContext,
  getListeningPort,
  runWithRequestContext,
} from "@databricks/appkit/testing";
import { genieVisualizationDownloadPath } from "@dbx-tools/shared-genie";
import { genieVisualizationImagePath } from "@dbx-tools/shared-mastra";
import express from "express";
import { MastraPlugin } from "../src/plugin.ts";

const reference = {
  alias: "sales",
  conversation_id: "conversation-1",
  message_id: "message-1",
  attachment_id: "visualization-1",
  statementId: "01f1d46a-94ed-1d92-932d-f8b2d193bbef",
};
const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 10, 20);

describe("Genie visualization image route", () => {
  it("serves exact bytes under OBO, does not cache them, and preserves upstream access errors", async () => {
    const requests: string[] = [];
    let upstreamStatus: number | undefined;
    const userClient = {
      apiClient: {
        request: async (request: { path: string; raw: boolean }) => {
          const context = getExecutionContext();
          assert.equal("isUserContext" in context, true);
          assert.equal("userId" in context && context.userId, "viewer-1");
          assert.equal(request.raw, true);
          requests.push(request.path);
          if (upstreamStatus) {
            throw Object.assign(new Error("Private upstream detail"), {
              statusCode: upstreamStatus,
            });
          }
          return { "content-type": "image/png", contents: new Response(png).body };
        },
      },
    } as unknown as WorkspaceClient;
    const serviceClient = {
      apiClient: {
        request: async () => {
          throw new Error("Must never use service principal");
        },
      },
    } as unknown as WorkspaceClient;
    const fixture = createTestPluginContext();
    const plugin = await fixture.attach(
      new MastraPlugin({
        genieSpaces: { [reference.alias]: "space-1" },
        genieVisualization: "image",
        genieIdentity: "service-principal",
        telemetry: false,
        retry: { enabled: false },
      }),
    );
    const app = express();
    const router = express.Router();
    plugin.injectRoutes(router);
    const mount = "/api/image-test";
    app.use(mount, router);
    app.use(((error, _req, res, _next) => {
      res.status(error.statusCode ?? 500).json({ error: "Request failed" });
    }) as express.ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1");
    const port = await getListeningPort(server);
    const url = `http://127.0.0.1:${port}${mount}${genieVisualizationImagePath(reference)}`;
    try {
      await runWithRequestContext(
        async () => {
          const headers = {
            "x-forwarded-access-token": "user-token",
            "x-forwarded-user": "viewer-1",
          };
          const response = await fetch(url, { headers });
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("content-type"), "image/png");
          assert.equal(response.headers.get("cache-control"), "private, no-store");
          assert.equal(response.headers.get("x-content-type-options"), "nosniff");
          assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
          assert.deepEqual(requests, [
            genieVisualizationDownloadPath({
              space_id: "space-1",
              conversation_id: reference.conversation_id,
              message_id: reference.message_id,
              attachment_id: reference.attachment_id,
            }),
          ]);
          for (const status of [403, 404]) {
            upstreamStatus = status;
            const failure = await fetch(url, { headers });
            assert.equal(failure.status, status);
            assert.equal(failure.headers.get("cache-control"), "private, no-store");
            assert.doesNotMatch(await failure.text(), /Private upstream detail/);
          }
          const before = requests.length;
          const unauthenticated = await fetch(url);
          assert.equal(unauthenticated.status, 401);
          assert.equal(requests.length, before);
          const unknownAlias = await fetch(
            `http://127.0.0.1:${port}${mount}${genieVisualizationImagePath({
              ...reference,
              alias: "unknown",
            })}`,
            { headers },
          );
          assert.equal(unknownAlias.status, 404);
          assert.equal(requests.length, before);
        },
        { userDatabricksClient: userClient, serviceDatabricksClient: serviceClient },
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
