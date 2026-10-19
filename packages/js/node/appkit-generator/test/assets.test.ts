import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverBrandAssets, discoverMobileAppVisuals } from "../src/assets.ts";

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

describe("mobile app visual discovery", () => {
  it("collects app-store metadata, structured screenshots, and responsive images", () => {
    const visuals = discoverMobileAppVisuals(
      `
        <html>
          <head>
            <meta property="og:title" content="Acme Mobile on the App Store">
            <meta property="og:image" content="/icon.png">
            <script type="application/ld+json">
              {
                "@type": "SoftwareApplication",
                "screenshot": [
                  {"contentUrl": "https://cdn.example/screen-one.webp"},
                  "https://cdn.example/screen-two.webp"
                ]
              }
            </script>
          </head>
          <body>
            <img alt="App screenshot" src="/small.png"
                 srcset="/small.png 1x, /large.png 2x">
          </body>
        </html>
      `,
      "https://apps.apple.com/us/app/acme/id123",
    );

    assert.equal(visuals.appName, "Acme Mobile");
    assert.deepEqual(visuals.imageUrls, [
      "https://apps.apple.com/icon.png",
      "https://apps.apple.com/small.png",
      "https://apps.apple.com/large.png",
      "https://cdn.example/screen-one.webp",
      "https://cdn.example/screen-two.webp",
    ]);
  });

  it("rejects non-HTTPS image references", () => {
    const visuals = discoverMobileAppVisuals(
      '<meta property="og:image" content="http://insecure.example/icon.png">',
      "https://play.google.com/store/apps/details?id=example",
    );
    assert.deepEqual(visuals.imageUrls, []);
  });
});
