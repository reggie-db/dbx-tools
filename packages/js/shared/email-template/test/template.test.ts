import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultBrandContext, parseBrandContext } from "@dbx-tools/shared-core";
import { dbxToolsEmailAssetDataUrls } from "../src/generated/assets.ts";
import {
  defaultEmailBrand,
  emailBrandFromContext,
  normalizeEmailMarkdown,
  resolveEmailBrand,
} from "../src/template.tsx";

describe("email template brand", () => {
  it("projects the repository brand into email-safe defaults", () => {
    assert.equal(defaultEmailBrand.accent, defaultBrandContext.colors.primary);
    assert.equal(defaultEmailBrand.background, defaultBrandContext.colors.surface);
    assert.equal(defaultEmailBrand.name, defaultBrandContext.name);
  });

  it("merges a consumer override over the repository defaults", () => {
    const resolved = resolveEmailBrand({
      accent: "#123456",
      fontFamily: "Arial, sans-serif",
      name: "Acme",
    });
    assert.equal(resolved.accent, "#123456");
    assert.equal(resolved.name, "Acme");
    assert.equal(resolved.border, defaultBrandContext.colors.border);
  });

  it("keeps fetchable brand assets and drops package references", () => {
    const remote = parseBrandContext({
      assets: { logo: { light: "https://example.com/logo.svg" } },
    });
    assert.equal(emailBrandFromContext(remote).logoUrl, "https://example.com/logo.svg");
    assert.equal(emailBrandFromContext(defaultBrandContext).logoUrl, undefined);
    assert.equal(defaultEmailBrand.logoUrl, dbxToolsEmailAssetDataUrls.logo);
  });

  it("embeds a transparent PNG for the dark email header", () => {
    const encoded = dbxToolsEmailAssetDataUrls.logo.split(",", 2)[1];
    assert.ok(encoded);
    const png = Buffer.from(encoded, "base64");
    assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(png[25], 6, "PNG color type must be RGBA");
  });
});

describe("email content normalization", () => {
  it("removes shared indentation without rewriting content", () => {
    assert.equal(normalizeEmailMarkdown("\n    # Hello\n\n    World\n"), "# Hello\n\nWorld");
  });
});
