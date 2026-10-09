import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openApiTools } from "../src/openapi-tool.ts";

const OPENAPI = {
  paths: {
    "/memories": {
      get: {
        operationId: "memory-search",
        description: "Search stored memories.",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SearchResult" },
              },
            },
          },
        },
      },
      post: {
        operationId: "memory-create",
        summary: "Create a memory",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateMemory" },
            },
          },
        },
        responses: {
          "201": {
            content: {
              "application/json; charset=utf-8": {
                schema: { $ref: "#/components/schemas/Memory" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      CreateMemory: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      Memory: {
        type: "object",
        properties: { id: { type: "string" }, text: { type: "string" } },
        required: ["id", "text"],
      },
      SearchResult: {
        type: "object",
        properties: {
          facts: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["facts"],
      },
    },
  },
};

describe("openApiTools", () => {
  it("loads a local file and includes every declared HTTP method", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openapi-tool-"));
    const path = join(directory, "openapi.json");
    try {
      await writeFile(path, JSON.stringify(OPENAPI));
      const tools = await openApiTools(path);

      assert.deepEqual(
        tools.map(({ id, method, url }) => ({ id, method, url })),
        [
          { id: "memory-search", method: "GET", url: "/memories" },
          { id: "memory-create", method: "POST", url: "/memories" },
        ],
      );
      assert.deepEqual(tools[0]?.inputSchema, { type: "object" });
      assert.deepEqual(tools[1]?.inputSchema, OPENAPI.components.schemas.CreateMemory);
      assert.deepEqual(tools[1]?.outputSchema, OPENAPI.components.schemas.Memory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads HTTP OpenAPI documents and resolves operation URLs", async () => {
    const originalFetch = globalThis.fetch;
    const inputs: string[] = [];
    const authorizations: Array<string | null> = [];
    globalThis.fetch = (async (input, init) => {
      inputs.push(String(input));
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Response.json(OPENAPI);
    }) as typeof fetch;
    try {
      const tools = await openApiTools("https://schema.example.com/openapi.json", {
        headers: { authorization: "Bearer secret" },
      });

      assert.deepEqual(inputs, ["https://schema.example.com/openapi.json"]);
      assert.deepEqual(authorizations, ["Bearer secret"]);
      assert.ok(tools.every(({ url }) => url === "https://schema.example.com/memories"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
