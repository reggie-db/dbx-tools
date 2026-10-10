import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createShikiPlugin, highlightToHtml } from "@dbx-tools/ui/react";
import {
  formatRawToolPayload,
  humanizeToolName,
  structuredToolPayload,
  toolInputPresentation,
  toolOutputPresentation,
  webSearchProgressGroups,
  webSearchQueryLabel,
  webSearchResultLabel,
} from "../src/react/tool-pill.tsx";

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

  it("detects object payloads and complete JSON strings for table rendering", () => {
    const nested = { rows: [{ store: { id: 1 } }] };

    assert.equal(structuredToolPayload(nested), nested);
    assert.deepEqual(structuredToolPayload(JSON.stringify(nested)), nested);
    assert.equal(structuredToolPayload("not json"), undefined);
    assert.equal(structuredToolPayload("{ incomplete"), undefined);
  });

  it("highlights formatted payloads with the JSON grammar", async () => {
    const payload = formatRawToolPayload({ request: true, count: 3 });
    const html = await highlightToHtml(payload, "json");

    assert.match(html, /<span style="--sdm-c:/);
    assert.match(html, /--shiki-dark:/);
    assert.match(html, /request/);
    assert.match(html, /count/);
  });

  it("highlights plaintext output fences", async () => {
    const output = "779a65e7023cd2e7";
    const plugin = createShikiPlugin();
    const result = await new Promise<NonNullable<ReturnType<typeof plugin.highlight>>>(
      (resolve) => {
        const immediate = plugin.highlight(
          {
            code: output,
            language: "text",
            themes: ["github-light-high-contrast", "github-dark-high-contrast"],
          },
          resolve,
        );
        if (immediate) resolve(immediate);
      },
    );

    assert.equal(plugin.supportsLanguage("text"), true);
    assert.deepEqual(plugin.getThemes(), [
      "github-light-high-contrast",
      "github-dark-high-contrast",
    ]);
    assert.match(result.rootStyle ?? "", /--shiki-dark:#/);
    assert.equal(
      result.tokens
        .flat()
        .map((token) => token.content)
        .join(""),
      output,
    );
  });
});

describe("tool request source formatting", () => {
  it("extracts Code Mode TypeScript without escaped request JSON", () => {
    assert.deepEqual(
      toolInputPresentation("execute_typescript", {
        code: "const files = await external_mastra_workspace_list_files({ path: '.' });\nreturn files;",
      }),
      {
        label: "Code",
        language: "typescript",
        source:
          "const files = await external_mastra_workspace_list_files({ path: '.' });\nreturn files;",
      },
    );
  });

  it("extracts workspace commands as shell source", () => {
    assert.deepEqual(
      toolInputPresentation("mastra_workspace_execute_command", {
        command: "bun test packages/js/ui/mastra/test/tool-pill.test.ts",
        timeout: 30,
      }),
      {
        label: "Command",
        language: "bash",
        source: "bun test packages/js/ui/mastra/test/tool-pill.test.ts",
      },
    );
  });

  it("keeps generic tool requests on the raw payload path", () => {
    assert.equal(toolInputPresentation("read_url", { url: "https://example.com" }), undefined);
  });

  it("extracts Code Mode results into a separate output panel", () => {
    assert.deepEqual(
      toolOutputPresentation("execute_typescript", {
        success: true,
        result: [
          { path: "alpha.txt", characters: 5 },
          { path: "bravo.txt", characters: 6 },
        ],
        logs: [],
      }),
      {
        label: "Output",
        language: "json",
        source:
          '[\n  {\n    "path": "alpha.txt",\n    "characters": 5\n  },\n  {\n    "path": "bravo.txt",\n    "characters": 6\n  }\n]',
      },
    );
  });
});

describe("skill tool labels", () => {
  it("presents Code Mode as a user-facing workflow", () => {
    assert.equal(humanizeToolName("execute_typescript"), "Run Workflow");
  });

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
