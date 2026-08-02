import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { brand } from "@dbx-tools/shared-core";
import { defaultEmailBrand, emailBrandFromContext } from "../src/brand.ts";
import { renderEmailHtml, renderEmailText } from "../src/email-html.ts";

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
  it("uses the repository brand by default", async () => {
    const html = await renderEmailHtml({ subject: "S", body: "b" });
    assert.ok(html.includes(defaultEmailBrand.accent));
    assert.ok(html.includes("DM Sans"));
    assert.ok(html.includes(defaultEmailBrand.name!));
  });

  it("renders an <img> when the brand supplies a URL logo", async () => {
    const b = { ...defaultEmailBrand, logoUrl: "https://ex.com/logo.svg" };
    assert.ok((await renderEmailHtml({ subject: "S", body: "b", brand: b })).includes("<img"));
  });

  it("renders a matching plain-text alternative", async () => {
    const text = await renderEmailText({ subject: "Status", body: "## Resolved\nAll clear." });
    assert.match(text, /Status/i);
    assert.match(text, /Resolved/i);
    assert.match(text, /All clear\./);
  });
});
