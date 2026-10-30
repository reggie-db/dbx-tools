import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { detectCodeLanguage } from "../src/react/highlighted-code.tsx";
import {
  formatRecordPreviewJson,
  looksLikeMarkdown,
  markdownForPreview,
  parseNestedJsonText,
  recordPreviewRows,
} from "../src/react/record-preview-data.ts";
import { RecordPreview } from "../src/react/record-preview.tsx";

describe("RecordPreview", () => {
  it("keeps top-level and nested fields in one indented table without index headings", () => {
    const html = renderToStaticMarkup(
      createElement(RecordPreview, {
        value: {
          type: "write",
          files: [
            { path: "/first", content: "one" },
            { path: "/second", content: "two" },
          ],
        },
      }),
    );

    assert.match(html, />Type<\/div>/);
    assert.match(html, />Files<\/span>/);
    assert.match(html, />Path<\/div>/);
    assert.doesNotMatch(html, />[12]<\/(?:th|span|h3)>/);
    assert.equal(html.match(/data-slot="table"/g)?.length, 1);
    assert.doesNotMatch(html, /max-h-\[inherit\] min-w-0 overflow-auto/);
    assert.match(html, /overflow-clip/);
    assert.match(html, /pointer-events-none sticky top-1 z-20 flex h-0 justify-end pr-1/);
    assert.match(html, /pointer-events-auto size-6 bg-background shadow-sm ring-1 ring-border\/40/);
    assert.doesNotMatch(html, /relative min-w-0 max-w-full overflow-hidden/);
    assert.doesNotMatch(html, /border-l-2 border-border\/70/);
  });

  it("expands quoted JSON object fields and marks that they were parsed from text", () => {
    const html = renderToStaticMarkup(
      createElement(RecordPreview, {
        value: {
          metadata: '{"warehouse":"Serverless","output":{"format":"JSON"}}',
        },
      }),
    );

    assert.match(html, /aria-label="JSON parsed from text"/);
    assert.match(html, />Warehouse<\/div>/);
    assert.match(html, /<p>Serverless<\/p>/);
    assert.match(html, />Output<\/span>/);
    assert.equal(html.match(/data-slot="table"/g)?.length, 1);
  });

  it("recursively parses quoted JSON in nested fields and arrays while highlighting SQL", () => {
    const html = renderToStaticMarkup(
      createElement(RecordPreview, {
        value: {
          metadata: JSON.stringify({
            config: JSON.stringify({
              query: "SELECT store_id, SUM(sales) FROM sales GROUP BY store_id",
              payloads: [JSON.stringify({ deepValue: "found" })],
            }),
          }),
        },
      }),
    );

    assert.equal(html.match(/aria-label="JSON parsed from text"/g)?.length, 3);
    assert.match(html, /data-language="sql"/);
    assert.match(html, />Deep Value<\/div>/);
    assert.match(html, /<p>found<\/p>/);
    assert.equal(html.match(/data-slot="table"/g)?.length, 1);
  });

  it("renders Markdown strings inside recursively parsed JSON arrays", () => {
    const html = renderToStaticMarkup(
      createElement(RecordPreview, {
        value: {
          response: JSON.stringify({
            sections: ["## Result\n\n- first\n- second"],
          }),
        },
      }),
    );

    assert.match(html, /<h2[^>]*>Result<\/h2>/);
    assert.match(html, /<li[^>]*>first<\/li>/);
    assert.match(html, /<li[^>]*>second<\/li>/);
  });

  it("renders emphasized text and GFM tables inside fields", () => {
    const html = renderToStaticMarkup(
      createElement(RecordPreview, {
        value: {
          content:
            "**Current week inside sales PSPW and total**\n\n| business_week | sales_pspw | total_sales |\n| --- | ---: | ---: |\n| 2025-12-28 | 48138.36 | 8472350.82 |",
        },
      }),
    );

    assert.match(html, /data-streamdown="strong">Current week inside sales PSPW and total<\/span>/);
    assert.match(html, /<table/);
    assert.match(html, />business_week</);
    assert.match(html, /grid-cols-1 gap-1/);
    assert.match(html, /data-streamdown=table-wrapper\]\]:!border-0/);
    assert.match(html, /data-streamdown=table-wrapper\]\]:!bg-transparent/);
    assert.match(html, /data-streamdown=table-wrapper\]\]:!p-0/);
  });

  it("autolinks bare URLs through Streamdown and honors link safety", () => {
    const html = renderToStaticMarkup(
      createElement(RecordPreview, {
        value: {
          url: "https://raw.githubusercontent.com/example/project/main/file.ts",
        },
        linkSafety: { enabled: true },
      }),
    );

    assert.match(html, /<button[^>]*data-streamdown="link"/);
    assert.match(html, />https:\/\/raw\.githubusercontent\.com\/example\/project\/main\/file\.ts</);
    assert.doesNotMatch(html, /<a[^>]*href="https:\/\/raw\.githubusercontent\.com/);
  });

  it("autolinks URLs inside primitive arrays", () => {
    const html = renderToStaticMarkup(
      createElement(RecordPreview, {
        value: {
          sources: ["https://example.com/one", "https://example.com/two"],
        },
        linkSafety: { enabled: true },
      }),
    );

    assert.equal(html.match(/data-streamdown="link"/g)?.length, 2);
  });
});

describe("recordPreviewRows", () => {
  it("humanizes object keys into left-column labels", () => {
    assert.deepEqual(recordPreviewRows({ tool_name: "search", maxResults: 5 }), [
      { key: "tool_name", label: "Tool Name", value: "search" },
      { key: "maxResults", label: "Max Results", value: 5 },
    ]);
  });

  it("wraps non-objects as a single Value row", () => {
    assert.deepEqual(recordPreviewRows(["a", "b"]), [
      { key: "value", label: "Value", value: ["a", "b"] },
    ]);
  });

  it("returns no rows for nullish values", () => {
    assert.deepEqual(recordPreviewRows(null), []);
    assert.deepEqual(recordPreviewRows(undefined), []);
  });
});

describe("formatRecordPreviewJson", () => {
  it("pretty-prints objects and leaves strings authored", () => {
    assert.equal(formatRecordPreviewJson({ a: 1 }), '{\n  "a": 1\n}');
    assert.equal(formatRecordPreviewJson("already text"), "already text");
  });
});

describe("parseNestedJsonText", () => {
  it("parses complete quoted objects and arrays without accepting scalar text", () => {
    assert.deepEqual(parseNestedJsonText('{"nested":true}'), { nested: true });
    assert.deepEqual(parseNestedJsonText('[{"id":1}]'), [{ id: 1 }]);
    assert.equal(parseNestedJsonText("plain text"), undefined);
    assert.equal(parseNestedJsonText("true"), undefined);
    assert.equal(parseNestedJsonText("{ incomplete"), undefined);
  });
});

describe("detectCodeLanguage", () => {
  it("detects SQL independently of field names", () => {
    assert.equal(detectCodeLanguage("SELECT * FROM sales"), "sql");
    assert.equal(detectCodeLanguage("plain sentence"), undefined);
  });
});

const SKILL_MD = `---
name: joke-generator
description: Write short, friendly jokes.
---

# Joke generator

## Instructions

1. Use the user's requested topic.
2. Build a clear setup and punchline.
`;

describe("looksLikeMarkdown", () => {
  it("detects skill files with YAML frontmatter and headings", () => {
    assert.equal(looksLikeMarkdown(SKILL_MD), true);
  });

  it("ignores paths, labels, and hex colors", () => {
    assert.equal(
      looksLikeMarkdown("/Workspace/Users/reggie/.assistant/skills/joke-generator/SKILL.md"),
      false,
    );
    assert.equal(looksLikeMarkdown("joke-generator"), false);
    assert.equal(looksLikeMarkdown("#ffffff"), false);
  });

  it("detects emphasized text and GFM table separators", () => {
    assert.equal(looksLikeMarkdown("**Current reporting week**"), true);
    assert.equal(looksLikeMarkdown("| week | sales |\n| --- | ---: |\n| 2025-12-28 | 100 |"), true);
  });
});

describe("markdownForPreview", () => {
  it("fences YAML frontmatter so Streamdown does not treat --- as rules", () => {
    const preview = markdownForPreview(SKILL_MD);
    assert.match(preview, /^```yaml\nname: joke-generator/);
    assert.match(preview, /# Joke generator/);
    assert.doesNotMatch(preview, /^---/m);
  });
});
