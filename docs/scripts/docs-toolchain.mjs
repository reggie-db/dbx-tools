import fs from "node:fs";

const REQUIRED_PACKAGES = [
  "@astrojs/starlight",
  "astro",
  "mermaid",
  "typedoc",
  "typedoc-plugin-markdown",
];
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Node, not `process.execPath`. TypeDoc's published CLI `fork()`s itself, and
 * Bun re-evaluates `typedoc-plugin-markdown` on that path. Astro's `#!/usr/bin/env node`
 * shebang is also rewritten to Bun when launched through `bun run`.
 */
export const DOCS_NODE = "node";

const ASTRO_BIN = "./node_modules/astro/bin/astro.mjs";

/** Site package.json script that runs Astro under Node, bypassing Bun `.bin` shims. */
export function docsAstroScript(...args) {
  return [DOCS_NODE, ASTRO_BIN, ...args].join(" ");
}

/** Load and validate the committed exact-version documentation toolchain. */
export function loadDocsToolchain(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const dependencies = {};
  for (const name of REQUIRED_PACKAGES) {
    const version = parsed[name];
    if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
      throw new Error(`Documentation tool ${name} requires an exact version in ${file}`);
    }
    dependencies[name] = version;
  }
  const extras = Object.keys(parsed).filter((name) => !REQUIRED_PACKAGES.includes(name));
  if (extras.length > 0) {
    throw new Error(`Unknown documentation tools in ${file}: ${extras.join(", ")}`);
  }
  return dependencies;
}
