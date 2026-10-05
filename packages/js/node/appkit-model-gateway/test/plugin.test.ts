import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMockRouter } from "@databricks/appkit/testing";

import { ModelGatewayPlugin } from "../src/plugin.ts";

describe("ModelGatewayPlugin", () => {
  it("registers every compatibility route through AppKit", () => {
    const { router, handlers } = createMockRouter();
    const plugin = new ModelGatewayPlugin({});

    plugin.injectRoutes(router);

    assert.deepEqual(Object.keys(handlers), [
      "GET:/healthz",
      "GET:/v1/models",
      "POST:/v1/chat/completions",
      "POST:/v1/responses",
      "POST:/v1/messages",
      "POST:/v1/embeddings",
    ]);
    assert.deepEqual(plugin.getEndpoints(), {
      health: "/api/model-gateway/healthz",
      models: "/api/model-gateway/v1/models",
      chatCompletions: "/api/model-gateway/v1/chat/completions",
      responses: "/api/model-gateway/v1/responses",
      messages: "/api/model-gateway/v1/messages",
      embeddings: "/api/model-gateway/v1/embeddings",
    });
  });

  it("publishes a beta manifest without static workspace resources", () => {
    assert.equal(ModelGatewayPlugin.manifest.name, "modelGateway");
    assert.equal(ModelGatewayPlugin.manifest.stability, "beta");
    assert.deepEqual(ModelGatewayPlugin.manifest.resources, {
      required: [],
      optional: [],
    });
  });
});
