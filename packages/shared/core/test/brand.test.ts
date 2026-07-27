import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { brand } from "../index";

describe("brand context", () => {
  it("fills dbx tools defaults", () => {
    const context = brand.parseBrandContext();

    assert.equal(context.name, "dbx tools");
    assert.equal(context.assets.icon.light, brand.DEFAULT_BRAND_ASSETS.icon.light);
    assert.equal(context.colors.primary, "#FF3621");
  });

  it("validates nested overrides and preserves defaults", () => {
    const context = brand.parseBrandContext({
      name: "Example",
      colors: { primary: "#123456" },
    });

    assert.equal(context.name, "Example");
    assert.equal(context.colors.primary, "#123456");
    assert.equal(context.colors.background, "#FFFFFF");
  });

  it("exports schema and prompt forms for LLM consumers", () => {
    const schema = brand.brandContextJsonSchema();
    const prompt = brand.brandContextPrompt();

    assert.equal(schema.type, "object");
    assert.match(prompt, /dbx tools brand context/);
    assert.match(prompt, /"schemaVersion": "1"/);
  });
});
