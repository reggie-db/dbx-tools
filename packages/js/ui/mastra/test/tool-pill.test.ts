import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatRawToolPayload,
  humanizeToolName,
  webSearchProgressGroups,
  webSearchQueryLabel,
  webSearchResultLabel,
} from "../src/react/tool-pill.tsx";
import { createShikiPlugin, highlightToHtml } from "../src/support/shiki-plugin.ts";

describe("raw tool payload formatting", () => {
  it("preserves complete request and response values", () => {
    const payload = {
      query: "all stores",
      rows: Array.from({ length: 1_000 }, (_, index) => ({
        index,
        value: `row-${index}`,
      })),
    };

    const formatted = formatRawToolPayload(payload);

    assert.deepEqual(JSON.parse(formatted), payload);
    assert.match(formatted, /"row-999"/);
  });

  it("preserves string payloads verbatim", () => {
    const payload = "x".repeat(50_000);

    assert.equal(formatRawToolPayload(payload), payload);
  });

  it("highlights formatted payloads with the JSON grammar", async () => {
    const payload = formatRawToolPayload({ request: true, count: 3 });
    const html = await highlightToHtml(payload, "json");

    assert.match(html, /<span style="color:/);
    assert.match(html, /request/);
    assert.match(html, /count/);
  });

  it("highlights plaintext output fences", async () => {
    const output = "779a65e7023cd2e7";
    const plugin = createShikiPlugin();
    const result = await new Promise<NonNullable<ReturnType<typeof plugin.highlight>>>((resolve) => {
      const immediate = plugin.highlight(
        {
          code: output,
          language: "text",
          themes: ["github-light", "github-light"],
        },
        resolve,
      );
      if (immediate) resolve(immediate);
    });

    assert.equal(plugin.supportsLanguage("text"), true);
    assert.equal(result.tokens.flat().map((token) => token.content).join(""), output);
  });
});

describe("skill tool labels", () => {
  it("humanizes Mastra skill meta-tools for session pills", () => {
    assert.equal(humanizeToolName("search_skills"), "Search Skills");
    assert.equal(humanizeToolName("load_skill"), "Load Skill");
  });

  it("drops the Mastra workspace prefix from command and file tools", () => {
    assert.equal(humanizeToolName("mastra_workspace_execute_command"), "Execute Command");
    assert.equal(humanizeToolName("mastra_workspace_read_file"), "Read File");
  });
});

describe("streaming web-search progress", () => {
  it("groups each search with its nested result", () => {
    assert.deepEqual(
      webSearchProgressGroups({
        id: "web-search-1",
        toolName: "web_search",
        status: "running",
        progress: [
          {
            type: "tool_status",
            status: "search",
            message: "Searching: Databricks MCP",
            groupId: "search-1",
          },
          {
            type: "tool_status",
            status: "result",
            message: "Result",
            groupId: "search-1",
            detail: "4 related searches completed",
          },
        ],
      }),
      [
        {
          key: "search-1",
          search: {
            type: "tool_status",
            status: "search",
            message: "Searching: Databricks MCP",
            groupId: "search-1",
          },
          results: [
            {
              type: "tool_status",
              status: "result",
              message: "Result",
              groupId: "search-1",
              detail: "4 related searches completed",
            },
          ],
        },
      ],
    );
  });

  it("renders one-line query and result labels", () => {
    const [legacy] = webSearchProgressGroups({
      id: "web-search-1",
      toolName: "web_search",
      status: "complete",
      progress: [
        {
          type: "tool_status",
          status: "search",
          message: "Searching: Databricks MCP",
          groupId: "search-1",
        },
        {
          type: "tool_status",
          status: "result",
          message: "Result",
          groupId: "search-1",
          detail: "4 related searches completed",
        },
      ],
    });
    const [current] = webSearchProgressGroups({
      id: "web-search-2",
      toolName: "web_search",
      status: "complete",
      progress: [
        {
          type: "tool_status",
          status: "search",
          message: "Databricks MCP",
          groupId: "search-2",
        },
        {
          type: "tool_status",
          status: "result",
          message: "Result",
          groupId: "search-2",
          detail: "1 result",
        },
      ],
    });

    assert.equal(webSearchQueryLabel(legacy!), "Databricks MCP");
    assert.equal(webSearchResultLabel(legacy!), "4 results");
    assert.equal(webSearchQueryLabel(current!), "Databricks MCP");
    assert.equal(webSearchResultLabel(current!), "1 result");
  });
});
