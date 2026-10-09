import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWebSearchRuntime } from "../src/runtime.ts";
import { runWebSearch, type WebSearchContext } from "../src/search.ts";

describe("web-search provider fallback", () => {
  it("suppresses cross-region Gemini failures and retries GPT in the same call", async () => {
    const endpointNames = ["databricks-gemini-3-8-flash", "databricks-gpt-5-6-sol"];
    const client = {
      config: {
        async authenticate(_headers: Headers) {},
      },
      servingEndpoints: {
        async *list() {
          for (const name of endpointNames) yield { name, task: "llm/v1/chat" };
        },
      },
    } as unknown as WebSearchContext["client"];
    const context: WebSearchContext = { client, host: "https://workspace.example.com" };
    const runtime = createWebSearchRuntime();
    const originalFetch = globalThis.fetch;
    const models: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.includes("/serving-endpoints/")) return originalFetch(input, init);
      const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean };
      models.push(body.model);
      if (body.model.includes("gemini")) {
        return new Response(
          JSON.stringify({
            error_code: "INVALID_PARAMETER_VALUE",
            message:
              "Web search for Gemini is not available when cross-region processing is disabled.",
          }),
          { status: 400 },
        );
      }
      if (!body.stream) {
        return Response.json({ output_text: "GPT fallback answer", output: [] });
      }
      const frames = [
        {
          type: "response.output_item.done",
          item: {
            id: "search-1",
            type: "web_search_call",
            action: {
              type: "search",
              query: "Databricks MCP",
              queries: ["Databricks MCP", "Databricks MCP migration"],
            },
          },
        },
        {
          type: "response.completed",
          response: { output_text: "GPT fallback answer", output: [] },
        },
      ];
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const request = {
        query: "What changed?",
        model: "databricks-gpt-5-6-sol",
      };
      const progress: unknown[] = [];
      const first = await runWebSearch(request, runtime, context, undefined, async (event) => {
        progress.push(event);
      });
      const second = await runWebSearch(request, runtime, context);

      assert.equal(first.model, "databricks-gpt-5-6-sol");
      assert.equal(second.model, "databricks-gpt-5-6-sol");
      assert.deepEqual(models, [
        "databricks-gemini-3-8-flash",
        "databricks-gpt-5-6-sol",
        "databricks-gpt-5-6-sol",
      ]);
      assert.ok(runtime.familyCooldowns.get("gemini")! > Date.now());
      assert.deepEqual(progress, [
        {
          type: "tool_status",
          status: "search",
          message: "Databricks MCP",
          groupId: "search-1",
        },
        {
          type: "tool_status",
          status: "result",
          message: "Result",
          groupId: "search-1",
          detail: "2 results",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
