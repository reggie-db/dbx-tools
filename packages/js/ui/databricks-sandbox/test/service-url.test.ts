import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveServiceUrl } from "../src/react/service-url.ts";

describe("resolveServiceUrl", () => {
  it("opens AppKit service paths on the current origin", () => {
    assert.equal(
      resolveServiceUrl(
        "/sandbox/machine-1/stats",
        "https://dbx-tools-demo.example.databricksapps.com/chat/1",
      ),
      "https://dbx-tools-demo.example.databricksapps.com/sandbox/machine-1/stats",
    );
  });
});
