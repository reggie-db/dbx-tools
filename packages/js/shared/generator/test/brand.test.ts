import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultBrandContext } from "@dbx-tools/shared-core";
import {
  BrandGenerationEventSchema,
  GeneratorPluginClient,
  brandGenerateUrl,
} from "../src/brand.ts";

describe("brand generation browser contract", () => {
  it("derives the generation endpoint from the published base path", () => {
    assert.equal(
      brandGenerateUrl("/api/custom-generator/"),
      "/api/custom-generator/brand/generate",
    );
  });

  it("streams and validates progress followed by the generated package", async () => {
    const events = [
      {
        type: "progress",
        stage: "search",
        message: "Searching official sources",
      },
      {
        type: "result",
        package: {
          brand: defaultBrandContext,
          sources: [{ url: "https://dbx.tools/", title: "dbx tools", fetched: true }],
        },
      },
    ].map((event) => BrandGenerationEventSchema.parse(event));
    const body = events
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    let requestUrl = "";
    let requestBody = "";
    const client = new GeneratorPluginClient({ basePath: "/api/custom-generator" });
    const received = [];

    for await (const event of client.generate(
      { name: "dbx tools", website: "https://dbx.tools/" },
      {
        fetch: async (input, init) => {
          requestUrl = String(input);
          requestBody = String(init?.body);
          return new Response(body, {
            headers: { "Content-Type": "text/event-stream" },
          });
        },
      },
    )) {
      received.push(event);
    }

    assert.equal(requestUrl, "/api/custom-generator/brand/generate");
    assert.deepEqual(JSON.parse(requestBody), {
      name: "dbx tools",
      website: "https://dbx.tools/",
    });
    assert.deepEqual(received, events);
  });

  it("loads persisted generated brands from the published history route", async () => {
    let requestUrl = "";
    const client = new GeneratorPluginClient({ basePath: "/api/custom-generator" });
    const brands = await client.brandHistory({
      fetch: async (input) => {
        requestUrl = String(input);
        return Response.json({
          brands: [
            {
              id: "brand-1",
              request: { prompt: "dbx tools\ndbx.tools" },
              generatedAt: "2026-10-20T12:00:00.000Z",
              package: {
                brand: defaultBrandContext,
                sources: [{ url: "https://dbx.tools/", fetched: true }],
              },
            },
          ],
        });
      },
    });

    assert.equal(requestUrl, "/api/custom-generator/brand/history");
    assert.equal(brands[0]?.package.brand.name, defaultBrandContext.name);
  });
});
