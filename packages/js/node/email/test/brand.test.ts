import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultBrandContext, parseBrandContext } from "@dbx-tools/shared-core";
import { defaultEmailBrand, emailBrandFromContext } from "@dbx-tools/shared-email-template";
import { renderEmailHtml, renderEmailText } from "../src/email-html.ts";

describe("email brand", () => {
  it("derives accent, font, and name from a brand context", () => {
    const b = emailBrandFromContext(defaultBrandContext);
    assert.equal(b.accent, defaultBrandContext.colors.primary);
    assert.equal(b.fontFamily, defaultBrandContext.typography.sans);
    assert.equal(b.name, defaultBrandContext.name);
  });

  it("embeds the default logo as an email-safe PNG data URL", () => {
    assert.match(defaultEmailBrand.logoUrl!, /^data:image\/png;base64,/);
  });

  it("keeps an http(s) or data URL logo", () => {
    const ctx = parseBrandContext({
      assets: { logo: { light: "https://ex.com/l.svg", dark: "https://ex.com/d.svg" } },
    });
    // Dark logo wins - the header band is dark.
    assert.equal(emailBrandFromContext(ctx).logoUrl, "https://ex.com/d.svg");
  });

  it("does not add a tagline when the brand omits one", async () => {
    const brand = emailBrandFromContext(parseBrandContext());
    assert.equal(brand.tagline, undefined);
    assert.doesNotMatch(
      await renderEmailHtml({ subject: "S", body: "b", brand }),
      /Practical tools/,
    );
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

  it("uses the transport subject as the default body heading", async () => {
    const html = await renderEmailHtml({
      subject: "Weekly digest",
      body: "Your pipelines finished cleanly.",
    });
    assert.match(html, /Weekly digest\s*<\/h1>/);
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
