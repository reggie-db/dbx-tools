/**
 * Resolve the projen engine's `@dbx-tools/*` utility dependencies to the local
 * source under `../workspaces/` instead of a registry.
 *
 * `dev-projen` is a standalone project (NOT a member of the main pnpm
 * workspace), so pnpm can't see those packages as workspace siblings. This
 * `readPackage` hook rewrites the three utility deps to absolute `link:` paths
 * for EVERY package pnpm processes - including the linked source packages
 * themselves - so their own inter-dependencies (`node-path` -> `node-core` ->
 * `shared-core`, declared `workspace:*`) also resolve to the same local source
 * rather than dangling.
 *
 * When these packages are published, drop this file (or point the map at the
 * registry versions).
 */
const path = require("node:path");

const LINKS = {
  "@dbx-tools/shared-core": path.resolve(__dirname, "../workspaces/shared/core"),
  "@dbx-tools/node-core": path.resolve(__dirname, "../workspaces/node/core"),
  "@dbx-tools/node-path": path.resolve(__dirname, "../workspaces/node/path"),
};

function readPackage(pkg) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, abs] of Object.entries(LINKS)) {
      if (deps[name]) deps[name] = `link:${abs}`;
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
