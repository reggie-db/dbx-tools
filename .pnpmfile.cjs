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
 *
 * The link is RELATIVE on purpose. An absolute `path.resolve(__dirname, ...)`
 * gets recorded verbatim as the lockfile specifier, which pins the lockfile to
 * one machine's home directory - so every CI install fails
 * `ERR_PNPM_OUTDATED_LOCKFILE` comparing `link:/Users/<someone>/...` against
 * `link:/home/runner/...`. Relative keeps the lockfile portable. It resolves
 * against the IMPORTING package's directory, and the only importer inside this
 * workspace is the repo root; a nested package taking this dep would need its
 * own depth, so re-check this if that ever changes.
 */
const ENGINE_LINK = "link:./projen";

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
