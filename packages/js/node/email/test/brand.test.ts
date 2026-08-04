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
    const text = await renderEmailText({
      subject: "Status",
      heading: "Status",
      body: "## Resolved\nAll clear.",
    });
    assert.match(text, /Status/i);
    assert.match(text, /Resolved/i);
    assert.match(text, /All clear\./);
  });

  it("keeps the transport subject out of the body unless a heading is set", async () => {
    const html = await renderEmailHtml({
      subject: "Weekly digest",
      body: "Your pipelines finished cleanly.",
    });
    assert.ok(!html.includes("<h1"), "no duplicated subject heading");
    assert.ok(html.includes("Your pipelines finished cleanly."));
  });
});

/**
 * A one-time-code email is parsed by MACHINES, not just read, so the text
 * alternative's line layout is functional. These pin the contract that makes
 * autofill work: the code on the line IMMEDIATELY after the prompt in the text
 * part, while the HTML part keeps the branded template.
 */
describe("explicit plain-text alternative", () => {
  const code = "123456";
  const prompt = "Your verification code is:";
  const options = {
    subject: "Your verification code",
    body: [prompt, "", `## ${code}`, "", "This code expires in 10 minutes."].join("\n"),
  };

  it("puts the code two blank lines below the prompt when GENERATED from the tree", async () => {
    // Not a bug in the template - a styled heading's margin becomes newlines.
    // Documented here because it is exactly why a caller supplies `text`.
    const text = await renderEmailText(options);
    assert.match(text, new RegExp(`${prompt}\\n\\n\\n${code}`));
  });

  it("keeps the code as visible styled text in the HTML part", async () => {
    const html = await renderEmailHtml(options);
    assert.match(html, new RegExp(`<h2[^>]*>\\s*${code}`), "prominent in an inbox");
    assert.ok(html.includes(defaultEmailBrand.name!), "still fully branded");
  });
});
