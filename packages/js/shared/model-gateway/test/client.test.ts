import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createModelGatewayClient, ModelGatewayClientError } from "../src/client.ts";

describe("browser model-gateway client", () => {
  it("lists and searches standard models", async () => {
    let request: Request | undefined;
    const client = createModelGatewayClient({
      baseUrl: "https://app.example.com/api/",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ object: "list", data: [] });
      },
    });

    const response = await client.listModels({ search: "grok 4" });

    assert.deepEqual(response, { object: "list", data: [] });
    assert.equal(request?.url, "https://app.example.com/api/v1/models?search=grok+4");
    assert.equal(request?.headers.get("originator"), null);
  });

  it("requests and parses the Codex catalog", async () => {
    let originator: string | null = null;
    const client = createModelGatewayClient({
      baseUrl: "https://app.example.com/",
      fetch: async (input, init) => {
        originator = new Request(input, init).headers.get("originator");
        return Response.json({ models: [] });
      },
    });

    assert.deepEqual(await client.listModels({ codex: true }), { models: [] });
    assert.equal(originator, "codex");
  });

  it("throws a typed parsed gateway error", async () => {
    const client = createModelGatewayClient({
      baseUrl: "https://app.example.com/",
      fetch: async () =>
        Response.json(
          {
            error: {
              message: "No model",
              type: "invalid_request_error",
              code: 404,
            },
          },
          { status: 404 },
        ),
    });

    await assert.rejects(
      () => client.listModels(),
      (error) =>
        error instanceof ModelGatewayClientError &&
        error.status === 404 &&
        error.message === "No model",
    );
  });
});
