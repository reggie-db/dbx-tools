import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WebSearchPlugin } from "../src/plugin.ts";
import type { WebSearchExecutor } from "../src/runtime.ts";

interface ExecutorCall {
  owner: string;
}

function installExecutor(plugin: WebSearchPlugin, owner: string, calls: ExecutorCall[]): void {
  const execute = (async () => {
    calls.push({ owner });
    const path = owner === "first" ? "a" : "b";
    return {
      ok: true,
      data: {
        url: `https://1.1.1.1/${path}`,
        statusCode: 200,
        contentType: "text/html",
        body: `<title>${owner}</title><p>${owner} body</p>`,
      },
    };
  }) as WebSearchExecutor;
  Object.assign(plugin as object, { execute });
}

describe("web-search plugin runtime ownership", () => {
  it("isolates URL policies and executors across plugin shutdown", async () => {
    const calls: ExecutorCall[] = [];
    const first = new WebSearchPlugin({
      allowedUrls: ["1.1.1.1/a"],
      urlPolicy: "allowlist",
    });
    const second = new WebSearchPlugin({
      allowedUrls: ["1.1.1.1/b"],
      urlPolicy: "allowlist",
    });
    installExecutor(first, "first", calls);
    installExecutor(second, "second", calls);

    const firstPage = await first.exports().fetch({ url: "https://1.1.1.1/a", format: "text" });
    const secondPage = await second.exports().fetch({ url: "https://1.1.1.1/b", format: "text" });
    assert.match(firstPage.content, /first body/);
    assert.match(secondPage.content, /second body/);
    await assert.rejects(
      first.exports().fetch({ url: "https://1.1.1.1/b", format: "text" }),
      /allow-list/,
    );
    await assert.rejects(
      second.exports().fetch({ url: "https://1.1.1.1/a", format: "text" }),
      /allow-list/,
    );

    first.shutdown();
    const afterShutdown = await second
      .exports()
      .fetch({ url: "https://1.1.1.1/b", format: "text" });
    assert.match(afterShutdown.content, /second body/);
    assert.deepEqual(calls, [{ owner: "first" }, { owner: "second" }, { owner: "second" }]);
  });

  it("uses the host-selected model and forwards progress", async () => {
    const plugin = new WebSearchPlugin({});
    const progress: unknown[] = [];
    let selectedModel: string | undefined;
    Object.assign(plugin, {
      search: async (
        request: { query: string; model?: string },
        _signal: AbortSignal | undefined,
        writeProgress: ((event: unknown) => Promise<void>) | undefined,
      ) => {
        selectedModel = request.model;
        await writeProgress?.({
          type: "tool_status",
          status: "searching",
          message: "Searching the web",
        });
        return { query: request.query, answer: "done", citations: [], model: request.model! };
      },
    });

    const result = (await plugin.executeAgentTool(
      "web_search",
      { query: "current docs", model: "databricks-gpt-5-4" },
      undefined,
      {
        model: "databricks-gpt-6-1-sol",
        writeProgress: async (event) => {
          progress.push(event);
        },
      },
    )) as { model: string };

    assert.equal(selectedModel, "databricks-gpt-6-1-sol");
    assert.equal(result.model, "databricks-gpt-6-1-sol");
    assert.deepEqual(progress, [
      {
        type: "tool_status",
        status: "searching",
        message: "Searching the web",
      },
    ]);
  });
});
