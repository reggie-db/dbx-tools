/**
 * Resolve the projen engine's `@dbx-tools/*` dependencies to the local source
 * under `../packages/` instead of a registry.
 *
 * `projen/` is a standalone project (NOT a member of the main pnpm workspace), so
 * pnpm cannot see those packages as workspace siblings. The hook rewrites them for
 * EVERY package pnpm processes, including the linked source packages themselves,
 * so their own inter-dependencies (`node-path` -> `node-core` -> `shared-core`,
 * declared `workspace:*`) resolve to the same local source rather than dangling.
 * That is the default `createLinkHook` behavior, so no `baseFor` is needed.
 *
 * Nothing is enumerated here: whatever `@dbx-tools/*` package exists under
 * `../packages` is linked if this project declares it, in any dependency field. So
 * widening or narrowing the engine's own deps needs no edit in this file.
 *
 * The rewriting itself lives in the repo-root `.pnpmfile.cjs`, which this file
 * shares with `demo/`. A pnpmfile is per-INSTALL - pnpm loads it from the root of
 * the install being performed - so this workspace needs its own entry point even
 * though the logic is common. Required directly, with no existence guard: the root
 * file is always present for this project (unlike `demo/`, which is designed to be
 * copied out), and a missing link should fail loudly rather than silently install
 * registry copies.
 *
 * When these packages are published, drop this file.
 */
const path = require("node:path");

const { SCOPE, createLinkHook, scanPackages } = require("../.pnpmfile.cjs");

module.exports = {
  hooks: createLinkHook({
    caller: __filename,
    sources: scanPackages(path.join(__dirname, "..", "packages"), SCOPE),
  }),
};
