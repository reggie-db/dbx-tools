/**
 * Generates canonical model-proxy dashboard tokens and verifies embedded assets.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRAND_PATH = join(ROOT, "branding/brand.yaml");
const FAVICON_PATH = join(ROOT, "branding/assets/icon-light.svg");
const LOGO_LIGHT_PATH = join(ROOT, "branding/assets/logo-light.svg");
const LOGO_DARK_PATH = join(ROOT, "branding/assets/logo-dark.svg");
const GRIDSTACK_ROOT = join(ROOT, "node_modules/gridstack");
const UPLOT_ROOT = join(ROOT, "node_modules/uplot");
const DIST = join(ROOT, "packages/rs/model-proxy/metrics-ui/dist");
const BRAND_OUTPUT = join(DIST, "brand.0b7222df.css");
const WRITE = process.argv.includes("--write");

const FIGMA_ASSETS = {
  "assets/status-live-8.svg": [8, "#00A972"],
  "assets/status-warning-7.svg": [7, "#C26A00"],
  "assets/status-success-7.svg": [7, "#00A972"],
  "assets/status-info-7.svg": [7, "#0E538B"],
  "assets/status-info-8.svg": [8, "#0E538B"],
  "assets/status-muted-7.svg": [7, "#618794"],
  "assets/status-danger-8.svg": [8, "#C83B3B"],
  "assets/status-warning-8.svg": [8, "#C26A00"],
};

/** Render the dashboard token bridge from the canonical brand contract. */
function renderBrandCss(brand) {
  const { colors, typography } = brand;
  return `/* Generated from branding/brand.yaml by scripts/model-proxy-metrics-assets.mjs. */
:root {
  --brand-primary: ${colors.primary.toLowerCase()};
  --brand-primary-hover: ${colors.primaryHover.toLowerCase()};
  --brand-accent: ${colors.accent.toLowerCase()};
  --brand-foreground: ${colors.foreground.toLowerCase()};
  --brand-background: ${colors.background.toLowerCase()};
  --brand-surface: ${colors.surface.toLowerCase()};
  --brand-muted: ${colors.muted.toLowerCase()};
  --brand-border: ${colors.border.toLowerCase()};
  --brand-font-sans: ${typography.sans.replaceAll("'", '"')};
  --brand-font-mono: ${typography.mono.replaceAll("'", '"')};
}
`;
}

/** Render one approved Figma status marker without altering its geometry. */
function renderStatusAsset(size, color) {
  const radius = size / 2;
  return `<svg preserveAspectRatio="none" overflow="visible" style="display: block;" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" xmlns="http://www.w3.org/2000/svg">
<circle id="Ellipse" cx="${radius}" cy="${radius}" r="${radius}" fill="${color}"/>
</svg>
`;
}

/** Remove the package-home banner; the license is vendored beside the runtime. */
function renderUplotJavaScript(source) {
  return source.replace(/^\/\*![^\n]*\*\/\n?/, "");
}

/** Write or compare one deterministic embedded asset. */
function verify(path, expected) {
  if (WRITE) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, expected);
    return;
  }
  const actual = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (actual !== expected) {
    throw new Error(`${path} is stale; run bun scripts/model-proxy-metrics-assets.mjs --write`);
  }
}

const brand = parse(readFileSync(BRAND_PATH, "utf8"));
verify(BRAND_OUTPUT, renderBrandCss(brand));
verify(join(DIST, "assets/favicon.svg"), readFileSync(FAVICON_PATH, "utf8"));
verify(join(DIST, "assets/logo-light.svg"), readFileSync(LOGO_LIGHT_PATH, "utf8"));
verify(join(DIST, "assets/logo-dark.svg"), readFileSync(LOGO_DARK_PATH, "utf8"));
verify(
  join(DIST, "vendor/gridstack-all.js"),
  readFileSync(join(GRIDSTACK_ROOT, "dist/gridstack-all.js"), "utf8"),
);
verify(
  join(DIST, "vendor/gridstack.min.css"),
  readFileSync(join(GRIDSTACK_ROOT, "dist/gridstack.min.css"), "utf8"),
);
verify(
  join(DIST, "vendor/gridstack.LICENSE"),
  readFileSync(join(GRIDSTACK_ROOT, "LICENSE"), "utf8"),
);
verify(
  join(DIST, "vendor/uPlot.iife.min.js"),
  renderUplotJavaScript(readFileSync(join(UPLOT_ROOT, "dist/uPlot.iife.min.js"), "utf8")),
);
verify(
  join(DIST, "vendor/uPlot.min.css"),
  readFileSync(join(UPLOT_ROOT, "dist/uPlot.min.css"), "utf8"),
);
verify(join(DIST, "vendor/uPlot.LICENSE"), readFileSync(join(UPLOT_ROOT, "LICENSE"), "utf8"));
for (const [relativePath, [size, color]] of Object.entries(FIGMA_ASSETS)) {
  verify(join(DIST, relativePath), renderStatusAsset(size, color));
}

for (const file of [
  "index.html",
  "app.20cfdf0a.css",
  "app.js",
  "vendor/gridstack-all.js",
  "vendor/gridstack.min.css",
  "vendor/gridstack.LICENSE",
  "vendor/uPlot.iife.min.js",
  "vendor/uPlot.min.css",
  "vendor/uPlot.LICENSE",
]) {
  if (!existsSync(join(DIST, file))) {
    throw new Error(`Missing embedded dashboard asset: ${file}`);
  }
}

const runtimeAssets = [
  "index.html",
  "app.20cfdf0a.css",
  "app.js",
  "vendor/gridstack-all.js",
  "vendor/gridstack.min.css",
  "vendor/uPlot.iife.min.js",
  "vendor/uPlot.min.css",
]
  .map((file) => readFileSync(join(DIST, file), "utf8"))
  .join("\n");
if (/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(runtimeAssets)) {
  throw new Error("Embedded dashboard assets must not depend on runtime network content");
}
