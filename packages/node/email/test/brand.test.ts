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

/**
 * The AutoFill trailer only works if it really is the LAST line: iOS reads
 * `@<domain> #<code>` to bind a code to a website, and ignores it when anything
 * follows. The branded footer renders after the body, so these pin the ORDER
 * rather than mere presence - a trailer moved inside the card would still appear
 * in both parts while silently no longer autofilling.
 */
describe("autofill trailer placement", () => {
  const trailer = "@example.com #123456";
  const options = {
    subject: "Your verification code",
    body: "Your verification code is:\n\n## 123456\n\nThis code expires in 10 minutes.",
    trailer,
  };

  it("is the final line of the plain-text alternative", async () => {
    const text = await renderEmailText(options);
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    assert.equal(lines.at(-1), trailer, "nothing may follow the trailer");
  });

  it("renders after the branded footer in the HTML part", async () => {
    const html = await renderEmailHtml(options);
    assert.ok(html.includes(trailer));
    assert.ok(
      html.lastIndexOf(trailer) > html.lastIndexOf(defaultEmailBrand.name!),
      "the trailer must come after the brand footer, not inside the card",
    );
  });

  it("keeps the code visible text in both parts, never an image", async () => {
    const [html, text] = await Promise.all([renderEmailHtml(options), renderEmailText(options)]);
    // A client that scrapes the text part must still find the bare code alone on
    // its own line, which is the heuristic every client uses.
    assert.match(text, /^123456$/m);
    assert.ok(html.includes("123456"));
  });

  it("emits no trailer line when none is supplied", async () => {
    const { trailer: _omitted, ...withoutTrailer } = options;
    const text = await renderEmailText(withoutTrailer);
    assert.ok(!text.includes("@example.com #"));
  });
});
