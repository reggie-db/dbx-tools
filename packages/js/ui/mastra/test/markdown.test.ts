import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AssistantMarkdown, ToolMarkdown } from "../src/react/markdown.tsx";

const TABLE = "| KPI | Latest week |\n| --- | ---: |\n| Sales per store per week | $48,138.36 |";

describe("streaming Markdown tables", () => {
  it("defers table cells until the response settles", () => {
    const streaming = renderToStaticMarkup(
      createElement(AssistantMarkdown, { animate: true, children: TABLE }),
    );
    const settled = renderToStaticMarkup(
      createElement(AssistantMarkdown, { animate: false, children: TABLE }),
    );

    assert.match(streaming, /Building table/);
    assert.doesNotMatch(streaming, /Sales per store per week/);
    assert.match(settled, /Sales per store per week/);
    assert.doesNotMatch(settled, /Building table/);
  });
});

describe("tool Markdown typography", () => {
  it("pins prose and inline code to one text size", () => {
    const html = renderToStaticMarkup(
      createElement(ToolMarkdown, {
        children: "Checking `market_name` before querying the next table.",
      }),
    );

    assert.match(html, /!text-xs/);
    assert.match(html, /\[&amp;_p\]:!text-xs/);
    assert.match(html, /\[&amp;_code\]:!text-xs/);
  });
});
