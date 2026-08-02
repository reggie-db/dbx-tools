import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { brand } from "@dbx-tools/shared-core";
import {
  defaultEmailBrand,
  emailBrandFromContext,
  normalizeEmailMarkdown,
  resolveEmailBrand,
} from "../src/template.tsx";

describe("email template brand", () => {
  it("projects the repository brand into email-safe defaults", () => {
    assert.equal(defaultEmailBrand.accent, brand.defaultBrandContext.colors.primary);
    assert.equal(defaultEmailBrand.background, brand.defaultBrandContext.colors.surface);
    assert.equal(defaultEmailBrand.name, brand.defaultBrandContext.name);
  });

  it("merges a consumer override over the repository defaults", () => {
    const resolved = resolveEmailBrand({
      accent: "#123456",
      fontFamily: "Arial, sans-serif",
      name: "Acme",
    });
    assert.equal(resolved.accent, "#123456");
    assert.equal(resolved.name, "Acme");
    assert.equal(resolved.border, brand.defaultBrandContext.colors.border);
  });

  it("keeps fetchable brand assets and drops package references", () => {
    const remote = brand.parseBrandContext({
      assets: { logo: { light: "https://example.com/logo.svg" } },
    });
    assert.equal(emailBrandFromContext(remote).logoUrl, "https://example.com/logo.svg");
    assert.equal(defaultEmailBrand.logoUrl, undefined);
  });
});

describe("email content normalization", () => {
  it("removes shared indentation without rewriting content", () => {
    assert.equal(normalizeEmailMarkdown("\n    # Hello\n\n    World\n"), "# Hello\n\nWorld");
  });
});
