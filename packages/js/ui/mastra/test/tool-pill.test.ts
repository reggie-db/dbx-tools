import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatRawToolPayload,
  humanizeToolName,
  webSearchProgressGroups,
  webSearchQueryLabel,
  webSearchResultLabel,
} from "../src/react/tool-pill.tsx";
import { highlightToHtml } from "../src/support/shiki-plugin.ts";

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
});

describe("skill tool labels", () => {
  it("humanizes Mastra skill meta-tools for session pills", () => {
    assert.equal(humanizeToolName("search_skills"), "Search Skills");
    assert.equal(humanizeToolName("load_skill"), "Load Skill");
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
