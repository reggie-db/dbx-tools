import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatRawToolPayload } from "../src/react/tool-pill.tsx";
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
