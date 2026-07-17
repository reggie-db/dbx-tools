/**
 * Link the projen engine (`@dbx-tools/projen`) from the in-repo `projen/`
 * project instead of a registry.
 *
 * The engine used to be dogfooded as a workspace package, which created a
 * bootstrap cycle (the root's own synth depends on the engine it builds). It now
 * lives in the standalone `projen/` project, which is deliberately NOT a member
 * of this workspace. This `readPackage` hook rewrites any `@dbx-tools/projen`
 * dependency to a local `link:` so the root synth consumes the engine source
 * directly.
 *
 * The engine's own `@dbx-tools/*` utility deps (shared-core, node-core,
 * node-path) resolve as normal workspace members here, so they need no rewrite.
 *
 * When the engine is published, drop this file (or point it at the registry).
 */
const path = require("node:path");

const ENGINE_LINK = `link:${path.resolve(__dirname, "projen")}`;

function readPackage(pkg) {
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field];
    if (deps && deps["@dbx-tools/projen"]) {
      deps["@dbx-tools/projen"] = ENGINE_LINK;
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
