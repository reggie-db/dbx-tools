import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { brand } from "@dbx-tools/shared-core";
import {
  autofillTrailer,
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

describe("autofill trailer", () => {
  it("builds Apple's domain-bound one-time-code line", () => {
    assert.equal(autofillTrailer("demo.apps.dbx.tools", "123456"), "@demo.apps.dbx.tools #123456");
  });

  it("reduces a configured URL to the bare host iOS matches on", () => {
    for (const domain of [
      "https://www.example.com/app",
      "HTTP://Example.com",
      "example.com.",
      "example.com:8443",
      "  example.com  ",
    ]) {
      assert.equal(autofillTrailer(domain, "123456"), "@example.com #123456");
    }
  });

  it("omits the trailer when there is nothing iOS could match", () => {
    assert.equal(autofillTrailer(undefined, "123456"), undefined);
    assert.equal(autofillTrailer("example.com", undefined), undefined);
    assert.equal(autofillTrailer("", "123456"), undefined);
    assert.equal(autofillTrailer("localhost", "123456"), undefined);
    assert.equal(autofillTrailer("localhost:8000", "123456"), undefined);
  });
});
