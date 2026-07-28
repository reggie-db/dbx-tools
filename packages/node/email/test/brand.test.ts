import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { brand } from "@dbx-tools/shared-core";
import { defaultEmailBrand, emailBrandFromContext } from "../src/brand.ts";
import { renderEmailHtml } from "../src/email-html.ts";

describe("email brand", () => {
  it("derives accent, font, and name from a brand context", () => {
    const b = emailBrandFromContext(brand.defaultBrandContext);
    assert.equal(b.accent, brand.defaultBrandContext.colors.primary);
    assert.equal(b.fontFamily, brand.defaultBrandContext.typography.sans);
    assert.equal(b.name, brand.defaultBrandContext.name);
  });

  it("drops a logo that is not a fetchable URL (package-export path)", () => {
    // The default brand's logo is an `@dbx-tools/ui-branding/...svg` export
    // path, which can't load in a mail client, so no logoUrl is emitted.
    assert.equal(defaultEmailBrand.logoUrl, undefined);
  });

  it("keeps an http(s) or data URL logo", () => {
    const ctx = brand.parseBrandContext({
      assets: { logo: { light: "https://ex.com/l.svg", dark: "https://ex.com/d.svg" } },
    });
    // Dark logo wins - the header band is dark.
    assert.equal(emailBrandFromContext(ctx).logoUrl, "https://ex.com/d.svg");
  });
});

describe("renderEmailHtml branding", () => {
  it("inlines the brand accent and font, not the default blue", () => {
    const html = renderEmailHtml({ subject: "S", body: "b", brand: defaultEmailBrand });
    assert.ok(html.includes(defaultEmailBrand.accent));
    assert.ok(html.includes("Inter"));
    assert.ok(!html.includes("#0b6bcb"));
  });

  it("renders an <img> when the brand supplies a URL logo", () => {
    const b = { ...defaultEmailBrand, logoUrl: "https://ex.com/logo.svg" };
    assert.ok(renderEmailHtml({ subject: "S", body: "b", brand: b }).includes("<img"));
  });

  it("falls back to the neutral default palette with no brand", () => {
    assert.ok(renderEmailHtml({ subject: "S", body: "b" }).includes("#0b6bcb"));
  });
});
