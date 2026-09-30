import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeHtmlEntities, htmlFragmentToText, htmlToText } from "../src/html-text.ts";
import { parseDdgHtml } from "../src/scrape.ts";

describe("parser-backed HTML text", () => {
  it("handles quoted tag delimiters and the complete entity forms", () => {
    const fragment = '<a title="1 > 0"><strong>Revenue &copy; &#169; &#x1F680;</strong></a>';

    assert.equal(htmlFragmentToText(fragment), "Revenue © © 🚀");
    assert.equal(decodeHtmlEntities("&madeup; &#99999999;"), "&madeup; �");
  });

  it("preserves document structure while dropping inactive content", () => {
    const text = htmlToText(`
      <h1>Quarterly results</h1>
      <p>Revenue <strong>grew</strong><br>Profit followed</p>
      <script>secret()</script>
      <style>.secret { color: red }</style>
      <noscript>hidden fallback</noscript>
      <div><span>Malformed tail
    `);

    assert.match(text, /QUARTERLY RESULTS/i);
    assert.match(text, /Revenue grew/);
    assert.match(text, /Profit followed/);
    assert.match(text, /Malformed tail/);
    assert.doesNotMatch(text, /secret|hidden fallback/);
  });
});

describe("DuckDuckGo HTML parsing", () => {
  it("uses selectors regardless of attribute order or quoted delimiters", () => {
    const citations = parseDdgHtml(`
      <div class="result">
        <a data-label="A > B" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Freport"
           class="result__a"><strong>Revenue &amp; profit</strong></a>
        <a data-extra="x" class="result__snippet">A <em>useful</em> summary.</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.org/open">Malformed <b>result
        <a class="result__snippet">Still readable
      </div>
    `);

    assert.deepEqual(citations[0], {
      url: "https://example.com/report",
      title: "Revenue & profit",
      snippet: "A useful summary.",
    });
    assert.equal(citations[1]?.url, "https://example.org/open");
    assert.match(citations[1]?.title ?? "", /Malformed result/);
  });
});
