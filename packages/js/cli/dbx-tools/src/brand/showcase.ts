/**
 * Self-contained HTML presentation for an exported brand package.
 *
 * @module
 */

import { stringUtils } from "@dbx-tools/shared-core";
import type { BrandPackage } from "@dbx-tools/shared-generator";

function safeAsset(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^(?:data:image\/|https:\/\/)/i.test(value)) return value;
  return /^\.{0,2}\//.test(value) ? value : undefined;
}

function safeWebsite(value: string | undefined): string | undefined {
  return value && /^https:\/\//i.test(value) ? value : undefined;
}

function safeFontFamily(value: string): string {
  return /^[\w\s'",.-]+$/.test(value) ? value : "ui-sans-serif, system-ui, sans-serif";
}

function listItems(values: readonly string[]): string {
  return values.map((value) => `<li>${stringUtils.escapeHtml(value)}</li>`).join("");
}

/** Render one responsive brand presentation with desktop and mobile mockups. */
export function renderBrandShowcase(brandPackage: BrandPackage): string {
  const { brand, visualReferences } = brandPackage;
  const html = stringUtils.escapeHtml;
  const logo = safeAsset(brand.assets.logo.light) ?? safeAsset(brand.assets.icon.light);
  const icon = safeAsset(brand.assets.icon.light);
  const website = safeWebsite(brand.links.website);
  const screenshots = visualReferences
    .flatMap((reference) =>
      reference.images.flatMap((image) =>
        image.localPath
          ? [{ appName: reference.appName, platform: reference.platform, path: image.localPath }]
          : [],
      ),
    )
    .slice(0, 4);
  const identityMark = logo
    ? `<img src="${html(logo)}" alt="${html(brand.name)} logo">`
    : `<span class="wordmark">${html(brand.shortName)}</span>`;
  const compactMark = icon
    ? `<img src="${html(icon)}" alt="" aria-hidden="true">`
    : `<span class="compact-wordmark">${html(brand.shortName.slice(0, 2))}</span>`;
  const action = website
    ? `<a class="button" href="${html(website)}">Visit website</a>`
    : `<span class="button">Explore the brand</span>`;
  const gallery = screenshots.length
    ? `
      <section class="references" aria-labelledby="references-title">
        <div class="section-heading">
          <h2 id="references-title">Visual references</h2>
          <p>Supplemental mobile references used during research.</p>
        </div>
        <div class="reference-grid">
          ${screenshots
            .map(
              ({ appName, path, platform }) => `
                <figure>
                  <img src="${html(path)}" alt="${html(appName)} ${html(platform)} reference">
                  <figcaption>${html(appName)} / ${html(platform)}</figcaption>
                </figure>
              `,
            )
            .join("")}
        </div>
      </section>
    `
    : "";
  const headline = brand.tagline ?? brand.name;

  // prettier-ignore
  return stringUtils.dedent(
    // ============================================================================
    /*html*/`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${html(brand.name)} brand presentation</title>
        <style>
          :root {
            color-scheme: light;
            --primary: ${brand.colors.primary};
            --primary-hover: ${brand.colors.primaryHover};
            --accent: ${brand.colors.accent};
            --foreground: ${brand.colors.foreground};
            --background: ${brand.colors.background};
            --surface: ${brand.colors.surface};
            --muted: ${brand.colors.muted};
            --border: ${brand.colors.border};
            --sans: ${safeFontFamily(brand.typography.sans)};
            --mono: ${safeFontFamily(brand.typography.mono)};
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            background: var(--background);
            color: var(--foreground);
            font-family: var(--sans);
          }
          a { color: inherit; }
          img { display: block; max-width: 100%; }
          main { margin: 0 auto; max-width: 1240px; padding: 0 32px 72px; }
          .masthead {
            align-items: center;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            min-height: 88px;
          }
          .masthead img { max-height: 42px; max-width: 210px; }
          .wordmark { font-size: 24px; font-weight: 750; letter-spacing: -0.04em; }
          .meta { color: var(--muted); font-family: var(--mono); font-size: 12px; }
          .identity {
            display: grid;
            gap: 48px;
            grid-template-columns: minmax(0, 1.4fr) minmax(260px, 0.6fr);
            padding: 72px 0 64px;
          }
          .identity h1 {
            font-size: clamp(48px, 8vw, 104px);
            letter-spacing: -0.065em;
            line-height: 0.92;
            margin: 0;
            max-width: 850px;
          }
          .identity-copy { align-self: end; }
          .identity-copy p { color: var(--muted); font-size: 17px; line-height: 1.65; margin: 0 0 28px; }
          .button {
            background: var(--primary);
            border-radius: 999px;
            color: var(--background);
            display: inline-flex;
            font-weight: 700;
            padding: 12px 20px;
            text-decoration: none;
          }
          .showcase {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 28px;
            overflow: hidden;
            padding: 38px;
          }
          .section-heading { align-items: end; display: flex; gap: 24px; justify-content: space-between; margin-bottom: 28px; }
          .section-heading h2 { font-size: 30px; letter-spacing: -0.035em; margin: 0; }
          .section-heading p { color: var(--muted); margin: 0; max-width: 460px; text-align: right; }
          .devices { align-items: end; display: grid; gap: 28px; grid-template-columns: minmax(0, 1fr) 280px; }
          .browser, .phone {
            background: var(--background);
            border: 1px solid color-mix(in srgb, var(--foreground) 18%, transparent);
            box-shadow: 0 24px 70px color-mix(in srgb, var(--foreground) 13%, transparent);
            overflow: hidden;
          }
          .browser { border-radius: 18px; }
          .browser-bar { align-items: center; background: var(--foreground); display: flex; gap: 7px; height: 38px; padding: 0 16px; }
          .browser-bar i { background: var(--accent); border-radius: 50%; display: block; height: 7px; opacity: 0.8; width: 7px; }
          .browser-nav, .phone-nav { align-items: center; display: flex; justify-content: space-between; padding: 20px 24px; }
          .browser-nav img { max-height: 30px; max-width: 150px; }
          .nav-links { color: var(--muted); display: flex; font-size: 12px; gap: 22px; }
          .mock-hero { display: grid; gap: 28px; grid-template-columns: 1.1fr 0.9fr; min-height: 350px; padding: 44px; }
          .mock-copy { align-self: center; }
          .mock-copy h3 { font-size: clamp(34px, 5vw, 64px); letter-spacing: -0.055em; line-height: 0.98; margin: 0 0 22px; }
          .mock-copy p { color: var(--muted); line-height: 1.55; margin: 0 0 24px; max-width: 520px; }
          .mock-visual {
            align-content: end;
            background: var(--primary);
            border-radius: 20px;
            color: var(--background);
            display: grid;
            min-height: 250px;
            overflow: hidden;
            padding: 28px;
            position: relative;
          }
          .mock-visual::before {
            background: var(--accent);
            border-radius: 50%;
            content: "";
            height: 210px;
            position: absolute;
            right: -70px;
            top: -80px;
            width: 210px;
          }
          .mock-visual strong { font-size: 22px; line-height: 1.15; max-width: 220px; position: relative; }
          .phone { border: 8px solid var(--foreground); border-radius: 34px; }
          .phone-screen { min-height: 540px; }
          .phone-nav { padding: 18px; }
          .phone-nav img { height: 30px; max-width: 112px; object-fit: contain; object-position: left center; }
          .phone-mark img { height: 30px; width: 30px; }
          .compact-wordmark { font-weight: 800; }
          .phone-copy { padding: 34px 22px 24px; }
          .phone-copy h3 { font-size: 38px; letter-spacing: -0.05em; line-height: 0.98; margin: 0 0 18px; }
          .phone-copy p { color: var(--muted); font-size: 14px; line-height: 1.55; margin: 0; }
          .phone-accent { background: var(--accent); height: 120px; margin: 18px 22px 22px; }
          .system {
            display: grid;
            gap: 48px;
            grid-template-columns: 1fr 1fr;
            padding: 72px 0;
          }
          .palette { display: grid; grid-template-columns: repeat(4, 1fr); min-height: 250px; }
          .swatch { align-items: end; display: flex; padding: 16px; }
          .swatch span { background: var(--background); color: var(--foreground); font-family: var(--mono); font-size: 11px; padding: 5px 7px; }
          .type-specimen { border-top: 1px solid var(--border); padding-top: 24px; }
          .type-specimen strong { display: block; font-size: clamp(44px, 6vw, 76px); letter-spacing: -0.05em; line-height: 0.95; }
          .type-specimen code { color: var(--muted); display: block; font-family: var(--mono); margin-top: 20px; }
          .voice { border-top: 1px solid var(--border); display: grid; gap: 32px; grid-template-columns: 1fr 1fr; padding: 36px 0; }
          .voice h2 { font-size: 30px; letter-spacing: -0.035em; margin: 0; }
          .voice h3 { font-size: 14px; margin: 0 0 12px; }
          .voice ul { color: var(--muted); line-height: 1.6; margin: 0; padding-left: 18px; }
          .references { border-top: 1px solid var(--border); padding-top: 56px; }
          .reference-grid { display: grid; gap: 18px; grid-template-columns: repeat(4, 1fr); }
          figure { margin: 0; }
          figure img { aspect-ratio: 9 / 16; background: var(--surface); border: 1px solid var(--border); object-fit: contain; width: 100%; }
          figcaption { color: var(--muted); font-size: 11px; margin-top: 8px; }
          @media (max-width: 860px) {
            main { padding: 0 18px 48px; }
            .identity, .system { grid-template-columns: 1fr; }
            .identity { gap: 28px; padding: 52px 0 44px; }
            .showcase { border-radius: 20px; padding: 20px; }
            .devices { grid-template-columns: 1fr; }
            .phone { margin: 0 auto; max-width: 320px; width: 100%; }
            .reference-grid { grid-template-columns: repeat(2, 1fr); }
          }
          @media (max-width: 560px) {
            .masthead { min-height: 72px; }
            .identity h1 { font-size: 52px; }
            .section-heading { align-items: start; flex-direction: column; }
            .section-heading p { text-align: left; }
            .mock-hero { grid-template-columns: 1fr; padding: 24px; }
            .mock-visual { min-height: 190px; }
            .nav-links { display: none; }
            .palette { grid-template-columns: 1fr 1fr; }
            .voice { grid-template-columns: 1fr; }
          }
          @media (prefers-reduced-motion: no-preference) {
            .button { transition: background-color 160ms ease, transform 160ms ease; }
            .button:hover { background: var(--primary-hover); transform: translateY(-1px); }
          }
          .button:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
        </style>
      </head>
      <body>
        <main>
          <header class="masthead">
            ${identityMark}
            <span class="meta">Brand system / ${html(brand.schemaVersion)}</span>
          </header>

          <section class="identity" aria-labelledby="brand-name">
            <h1 id="brand-name">${html(brand.name)}</h1>
            <div class="identity-copy">
              <p>${html(brand.description)}</p>
              ${action}
            </div>
          </section>

          <section class="showcase" aria-labelledby="mockup-title">
            <div class="section-heading">
              <h2 id="mockup-title">Website mockups</h2>
              <p>One responsive direction shown at desktop and mobile sizes.</p>
            </div>
            <div class="devices">
              <article class="browser" aria-label="Desktop website mockup">
                <div class="browser-bar"><i></i><i></i><i></i></div>
                <div class="browser-nav">
                  ${identityMark}
                  <div class="nav-links"><span>Overview</span><span>Product</span><span>Resources</span></div>
                </div>
                <div class="mock-hero">
                  <div class="mock-copy">
                    <h3>${html(headline)}</h3>
                    <p>${html(brand.description)}</p>
                    ${action}
                  </div>
                  <div class="mock-visual">
                    <strong>${html(brand.voice.principles[0] ?? brand.name)}</strong>
                  </div>
                </div>
              </article>

              <article class="phone" aria-label="Mobile website mockup">
                <div class="phone-screen">
                  <div class="phone-nav">
                    <span class="phone-mark">${compactMark}</span>
                    <span class="meta">Menu</span>
                  </div>
                  <div class="phone-copy">
                    <h3>${html(headline)}</h3>
                    <p>${html(brand.description)}</p>
                  </div>
                  <div class="phone-accent"></div>
                </div>
              </article>
            </div>
          </section>

          <section class="system" aria-label="Brand system">
            <div>
              <div class="section-heading"><h2>Core palette</h2></div>
              <div class="palette">
                <div class="swatch" style="background: var(--primary)"><span>${brand.colors.primary}</span></div>
                <div class="swatch" style="background: var(--accent)"><span>${brand.colors.accent}</span></div>
                <div class="swatch" style="background: var(--surface)"><span>${brand.colors.surface}</span></div>
                <div class="swatch" style="background: var(--foreground)"><span>${brand.colors.foreground}</span></div>
              </div>
            </div>
            <div>
              <div class="section-heading"><h2>Typography</h2></div>
              <div class="type-specimen">
                <strong>Aa 01</strong>
                <code>${html(brand.typography.sans)}</code>
              </div>
            </div>
          </section>

          <section class="voice" aria-labelledby="voice-title">
            <div>
              <h2 id="voice-title">Voice</h2>
              <p class="meta">${html(brand.voice.tone.join(", "))}</p>
            </div>
            <div>
              <h3>Principles</h3>
              <ul>${listItems(brand.voice.principles)}</ul>
            </div>
          </section>

          ${gallery}
        </main>
      </body>
    </html>
    `
    // ============================================================================
  );
}
