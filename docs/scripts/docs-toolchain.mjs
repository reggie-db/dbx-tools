import fs from "node:fs";

const REQUIRED_PACKAGES = ["@astrojs/starlight", "astro", "typedoc", "typedoc-plugin-markdown"];
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

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
