import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverBrandAssets } from "../src/assets.ts";

describe("brand asset discovery", () => {
  it("resolves first-party icon, logo, and JSON-LD references", () => {
    const assets = discoverBrandAssets(
      `
        <html>
          <head>
            <link rel="icon" href="/assets/icon.svg">
            <script type="application/ld+json">
              {
                "@type":"Organization",
                "url":"https://example.com/",
                "logo":{"contentUrl":"/assets/logo.svg"}
              }
            </script>
          </head>
        </html>
      `,
      "https://example.com/about",
    );

    assert.equal(assets.icon.light, "https://example.com/assets/icon.svg");
    assert.equal(assets.logo.light, "https://example.com/assets/logo.svg");
    assert.equal(assets.favicon, "https://example.com/assets/icon.svg");
  });

  it("falls back to the official origin favicon without dbx-tools artwork", () => {
    const assets = discoverBrandAssets("<html></html>", "https://example.com/about");
    assert.deepEqual(assets, {
      icon: { light: "https://example.com/favicon.ico" },
      logo: { light: "https://example.com/favicon.ico" },
      favicon: "https://example.com/favicon.ico",
    });
  });

  it("uses discovered artwork instead of an unverified conventional favicon", () => {
    const assets = discoverBrandAssets(
      '<meta property="og:image" content="/assets/brand.png">',
      "https://example.com/",
    );
    assert.equal(assets.icon.light, "https://example.com/assets/brand.png");
    assert.equal(assets.favicon, "https://example.com/assets/brand.png");
  });
});
