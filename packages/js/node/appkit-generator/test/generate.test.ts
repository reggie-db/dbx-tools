import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateBrandPackage, type BrandSynthesisInput } from "../src/generate.ts";
import type { BrandResearchClient } from "../src/research.ts";
import type { BrandGenerationProgressEvent, GeneratedBrandProfile } from "../src/schema.ts";

const profile: GeneratedBrandProfile = {
  name: "Acme",
  shortName: "Acme",
  tagline: "Tools for careful builders.",
  description: "Acme makes tools for application engineering teams.",
  colors: {
    primary: "#102A43",
    primaryHover: "#0B5CAD",
    accent: "#00A972",
    foreground: "#102A43",
    background: "#FFFFFF",
    surface: "#F5F7FA",
    muted: "#52667A",
    border: "#D8E0E8",
  },
  typography: {
    sans: "'Inter', ui-sans-serif, system-ui, sans-serif",
    mono: "'IBM Plex Mono', ui-monospace, monospace",
  },
  voice: {
    audience: ["application engineers", "platform teams"],
    tone: ["direct", "technical"],
    principles: ["Lead with the result.", "Use specific technical language."],
    avoid: ["unsupported claims", "vague jargon"],
  },
  links: {
    website: "https://acme.example/",
    repository: "https://github.com/example/invented",
    documentation: "https://acme.example/docs",
  },
};

describe("brand package generation", () => {
  it("searches, fetches, synthesizes, and attaches official page assets", async () => {
    const calls: Array<{ operation: "search" | "fetch"; value: unknown }> = [];
    const client: BrandResearchClient = {
      async search(request) {
        calls.push({ operation: "search", value: request });
        return {
          query: request.query,
          answer: "Acme serves application engineers with direct technical guidance.",
          model: "databricks-gemini",
          citations: [
            { url: "https://acme.example/docs", title: "Acme documentation" },
            { url: "https://news.example/acme", title: "Acme profile" },
          ],
        };
      },
      async fetch(request) {
        calls.push({ operation: "fetch", value: request });
        if (request.format === "html") {
          return {
            url: request.url,
            status: 200,
            contentType: "text/html",
            content:
              '<html><head><link rel="icon" href="/icon.svg"></head><body><img class="brand-logo" src="/logo.svg"></body></html>',
            truncated: false,
          };
        }
        return {
          url: request.url,
          status: 200,
          contentType: "text/html",
          title: request.url.includes("/docs") ? "Acme documentation" : "Acme",
          content: `Readable source for ${request.url}`,
          truncated: false,
        };
      },
    };
    let synthesisInput: BrandSynthesisInput | undefined;
    const progress: BrandGenerationProgressEvent[] = [];

    const generated = await generateBrandPackage(
      { name: "Acme", website: "https://acme.example/" },
      {
        client,
        maxSources: 2,
        synthesize: async (input) => {
          synthesisInput = input;
          return profile;
        },
        onProgress: (event) => {
          progress.push(event);
        },
      },
    );

    assert.equal(calls.filter(({ operation }) => operation === "search").length, 1);
    assert.equal(calls.filter(({ operation }) => operation === "fetch").length, 3);
    assert.equal(synthesisInput?.research.sources.length, 2);
    assert.ok(synthesisInput?.research.sources.every((source) => source.fetched));
    assert.equal(generated.brand.assets.icon.light, "https://acme.example/icon.svg");
    assert.equal(generated.brand.assets.logo.light, "https://acme.example/logo.svg");
    assert.equal(generated.brand.links.documentation, "https://acme.example/docs");
    assert.equal(generated.brand.links.repository, undefined);
    assert.equal(generated.sources.length, 2);
    assert.ok(generated.sources.every((source) => source.fetched));
    assert.deepEqual(
      progress.map(({ stage }) => stage),
      ["search", "fetch", "fetch", "fetch", "assets", "synthesize"],
    );
  });

  it("fails when search supplies no fetchable public source", async () => {
    const client: BrandResearchClient = {
      async search(request) {
        return {
          query: request.query,
          answer: "No source",
          model: "scrape:duckduckgo",
          citations: [{ url: "http://private.example", title: "Private" }],
        };
      },
      async fetch() {
        throw new Error("fetch should not run");
      },
    };

    await assert.rejects(
      generateBrandPackage(
        { name: "Unknown" },
        {
          client,
          synthesize: async () => profile,
        },
      ),
      /no public HTTPS sources/,
    );
  });
});
