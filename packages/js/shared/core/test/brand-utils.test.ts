import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { brandUtils } from "../index.ts";

describe("brand context", () => {
  it("fills dbx tools defaults", () => {
    const context = brandUtils.parseBrandContext();

    assert.equal(context.name, "dbx tools");
    assert.equal(context.assets.icon.light, brandUtils.DEFAULT_BRAND_ASSETS.icon.light);
    assert.equal(context.colors.primary, "#1B3139");
    assert.equal(context.colors.primaryHover, "#0E538B");
    assert.equal(context.colors.accent, "#00A972");
  });

  it("validates nested overrides and preserves defaults", () => {
    const context = brandUtils.parseBrandContext({
      name: "Example",
      colors: { primary: "#123456" },
    });

    assert.equal(context.name, "Example");
    assert.equal(context.colors.primary, "#123456");
    assert.equal(context.colors.background, "#FFFFFF");
  });

  it("exports schema and prompt forms for LLM consumers", () => {
    const schema = brandUtils.brandContextJsonSchema();
    const prompt = brandUtils.brandContextPrompt();

    assert.equal(schema.type, "object");
    assert.match(prompt, /dbx tools brand context/);
    assert.match(prompt, /"schemaVersion": "1"/);
  });
});
