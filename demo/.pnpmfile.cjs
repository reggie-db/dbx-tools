/**
 * Resolve the demo's CLIENT `@dbx-tools/*` dependencies to the local source under
 * `../packages/`, instead of the registry in `.npmrc`.
 *
 * The demo is a real downstream CONSUMER, so installing published versions is a
 * mode it has to keep. It is not the DEFAULT one, though: beside the packages in
 * this checkout, the common case is editing them, and a demo silently running a
 * published copy of the code you just changed is the more expensive surprise -
 * you restart, see the old behavior, and go looking for the bug in the wrong
 * place. So linking is on unless you opt out, and a `vite build --watch` picks
 * up every edit:
 *
 *   pnpm install                     # client resolves @dbx-tools/* from source
 *   DBX_TOOLS_LINK=0 pnpm install    # consumer mode: published versions
 *
 * The switch itself lives in the repo-root hook ({@link linkEnabled}) so both
 * workspaces read one env var rather than each deciding what counts as "on".
 *
 * A resolve-time hook rather than a script, because the toggle then mutates
 * NOTHING. An earlier `scripts/dev-link.mjs` rewrote the app manifest and
 * `pnpm-workspace.yaml` in place, which meant clearing projen's read-only bit,
 * inserting marker comments, keeping a sidecar of the pristine contents, and
 * restoring all of it to undo. Both files are projen-generated and
 * `pnpm-workspace.yaml` is COMMITTED, so a forgotten undo landed local dev state
 * in git. Resolution is the package manager's job, so doing it here removes that
 * whole failure mode: the mode is an env var on one command and the working tree
 * never changes.
 *
 * CLIENT ONLY, deliberately - this is the one place that narrows what gets linked,
 * and it is not a hand-maintained list but the closure of the client app's own
 * dependencies. Linking the SERVER packages does not work: a `link:`ed package
 * resolves its own dependencies from the MAIN repo's `node_modules`, which is a
 * different physical install from the demo's. The two trees hold
 * `@databricks/appkit` at one version under different peer-hashes, and
 * `@mastra/core` at different versions outright, so singletons like AppKit's
 * `CacheManager` initialize in one copy and are read from the other
 * ("CacheManager not initialized"). The browser build sidesteps this because Vite
 * bundles from source and dedupes React (`vite.config.override.js`); tsx has no
 * equivalent. Unifying it would need ONE shared store, i.e. one workspace, which is
 * exactly the standalone-consumer property the demo exists to demonstrate. To try
 * it anyway, drop the `dependencyClosure` call below and pass `sources` straight
 * through.
 *
 * Scoping is by CONSUMER, not by dependency name: the server app also depends on
 * `@dbx-tools/shared-core`, which the client pulls too, so filtering on the name
 * alone would source-link the server's copy as a side effect.
 *
 * The rewriting itself lives in the repo-root `.pnpmfile.cjs`, shared with
 * `projen/`. Required through a guard, unlike `projen/`: this folder is designed to
 * be copied out and run on its own (see `.projenrc.ts`), and out there neither the
 * root hook nor `../packages` exists. Link mode simply becomes unavailable, which is
 * the correct outcome - there would be no source to link to - and the copy installs
 * from the registry with no env var involved. That guard is also why the existence
 * checks run BEFORE the switch: out there, there is nothing to ask.
 */
const fs = require("node:fs");
const path = require("node:path");

const demoRoot = __dirname;
const packagesRoot = path.join(demoRoot, "..", "packages");
/** The one demo member whose deps are linked: the browser client (see above). */
const clientDir = path.join(demoRoot, "app/appkit-demo");
const sharedHookPath = path.join(demoRoot, "..", ".pnpmfile.cjs");

/** Passthrough for consumer mode, and for a copied-out demo with no source beside it. */
const PASSTHROUGH = { readPackage: (pkg) => pkg };

function resolveHooks() {
  // Existence first, then the switch: a copied-out demo has no root hook to ask.
  if (!fs.existsSync(sharedHookPath) || !fs.existsSync(packagesRoot)) return PASSTHROUGH;

  const shared = require(sharedHookPath);
  if (!shared.linkEnabled()) return PASSTHROUGH;

  const clientManifest = shared.readJson(path.join(clientDir, "package.json"));
  if (!clientManifest) return PASSTHROUGH;

  const sources = shared.scanPackages(packagesRoot, shared.SCOPE);
  const entry = shared.scopedDeps(clientManifest, shared.SCOPE);
  const linked = shared.dependencyClosure(entry, sources, shared.SCOPE);
  if (linked.size === 0) return PASSTHROUGH;

  return shared.createLinkHook({
    caller: __filename,
    sources: linked,
    // The client app is a workspace MEMBER, so its specifiers resolve against its
    // own directory; the linked packages are transitive, so theirs resolve against
    // the lockfile's directory (this demo root). Everything else, the server app
    // above all, is left alone.
    baseFor: (name) => {
      if (name === clientManifest.name) return clientDir;
      return linked.has(name) ? demoRoot : undefined;
    },
  });
}

module.exports = { hooks: resolveHooks() };
