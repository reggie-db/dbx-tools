import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { server } from "@databricks/appkit";
import { createTestPlugin, getListeningPort } from "@databricks/appkit/testing";
import { MODEL_GATEWAY_DEFAULTS } from "@dbx-tools/shared-model-gateway/options";

import { modelGatewayServerOptions } from "../src/model-gateway/server.ts";

describe("model gateway server", () => {
  it("accepts long Codex histories with a bounded JSON body limit", () => {
    assert.deepEqual(modelGatewayServerOptions(), {
      bodyLimit: MODEL_GATEWAY_DEFAULTS.bodyLimit,
      host: "localhost",
      port: 4000,
    });
    assert.equal(MODEL_GATEWAY_DEFAULTS.bodyLimit, "100mb");
  });

  it("parses requests beyond the previous 16 MB gateway boundary", async () => {
    const plugin = createTestPlugin(server, modelGatewayServerOptions({ listen: 0 }));
    plugin.extend((application) => {
      application.post("/large-json", (request, response) => {
        const body = request.body as { input?: unknown };
        response.json({ length: typeof body.input === "string" ? body.input.length : -1 });
      });
    });
    await plugin.start();
    const httpServer = plugin.getServer();
    try {
      const port = await getListeningPort(httpServer);
      const input = "x".repeat(16 * 1024 * 1024 + 1);
      const response = await fetch(`http://localhost:${port}/large-json`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { length: input.length });
    } finally {
      await new Promise<void>((resolve, reject) => {
        if (!httpServer.listening) {
          resolve();
          return;
        }
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("allows embedded callers to override the body limit", () => {
    assert.deepEqual(modelGatewayServerOptions({ bodyLimit: "4mb", listen: "localhost:4400" }), {
      bodyLimit: "4mb",
      host: "localhost",
      port: 4400,
    });
  });
});
