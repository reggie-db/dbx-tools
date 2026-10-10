import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RecordPreview } from "../src/react/record-preview.tsx";
import {
  formatRecordPreviewJson,
  looksLikeMarkdown,
  markdownForPreview,
  recordPreviewRows,
} from "../src/react/record-preview-data.ts";

describe("RecordPreview", () => {
  it("stacks nested arrays beneath their field without index headings", () => {
    const html = renderToStaticMarkup(
      createElement(RecordPreview, {
        value: {
          files: [
            { path: "/first", content: "one" },
            { path: "/second", content: "two" },
          ],
        },
      }),
    );

    assert.match(html, /colSpan="2">Files<\/th>/);
    assert.match(html, />Path<\/th>/);
    assert.doesNotMatch(html, />1<\/th>/);
    assert.match(html, /max-h-\[inherit\] min-w-0 overflow-auto/);
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
