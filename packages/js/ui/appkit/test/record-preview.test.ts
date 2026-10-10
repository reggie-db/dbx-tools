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

    assert.match(html, />Type<\/th>/);
    assert.match(html, />Files<\/span>/);
    assert.match(html, />Path<\/th>/);
    assert.doesNotMatch(html, />[12]<\/(?:th|span|h3)>/);
    assert.equal(html.match(/data-slot="table"/g)?.length, 1);
    assert.doesNotMatch(html, /max-h-\[inherit\] min-w-0 overflow-auto/);
    assert.match(html, /sticky top-1 z-10 float-right/);
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
    assert.match(html, />Warehouse<\/th>/);
    assert.match(html, />Serverless<\/span><\/td>/);
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
    assert.match(html, />Deep Value<\/th>/);
    assert.match(html, />found<\/span><\/td>/);
    assert.equal(html.match(/data-slot="table"/g)?.length, 1);
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
});

describe("markdownForPreview", () => {
  it("fences YAML frontmatter so Streamdown does not treat --- as rules", () => {
    const preview = markdownForPreview(SKILL_MD);
    assert.match(preview, /^```yaml\nname: joke-generator/);
    assert.match(preview, /# Joke generator/);
    assert.doesNotMatch(preview, /^---/m);
  });
});
