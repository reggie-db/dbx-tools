import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getRequestTags, injectRequestTag, injectRequestTags } from "../src/request-tags.ts";

describe("AppKit request tags", () => {
  it("merges plugin tags without leaking across requests", () => {
    const first = {};
    const second = {};

    injectRequestTag(first, "agent", true);
    injectRequestTags(first, { tunnel: "portr", tunnel_subdomain: "demo", skipped: undefined });

    assert.deepEqual(getRequestTags(first), {
      agent: true,
      tunnel: "portr",
      tunnel_subdomain: "demo",
    });
    assert.deepEqual(getRequestTags(second), {});
  });
});
