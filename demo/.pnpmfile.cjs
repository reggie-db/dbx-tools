/**
 * Resolve the demo's CLIENT `@dbx-tools/*` dependencies to the local source under
 * `../packages/` when `DBX_TOOLS_LINK=1` is set, instead of the registry in
 * `.npmrc`.
 *
 * The demo is a real downstream CONSUMER: by default every `@dbx-tools/*` package
 * installs as a normal versioned dependency, exactly as an external app would.
 * That is the right mode when the demo is the thing under development. When the
 * PACKAGES are what you are editing, the bump -> publish -> update -> rebuild loop
 * is too slow, so this hook points the client at source and a `vite build --watch`
 * picks up every edit:
 *
 *   DBX_TOOLS_LINK=1 pnpm install    # client resolves @dbx-tools/* from source
 *   pnpm install                     # back to the registry consumer
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
 * the correct outcome - there would be no source to link to - and the default
 * registry install keeps working.
 */
const fs = require("node:fs");
const path = require("node:path");

const LINK = process.env.DBX_TOOLS_LINK === "1";

const demoRoot = __dirname;
const packagesRoot = path.join(demoRoot, "..", "packages");
/** The one demo member whose deps are linked: the browser client (see above). */
const clientDir = path.join(demoRoot, "app/appkit-demo");
const sharedHookPath = path.join(demoRoot, "..", ".pnpmfile.cjs");

/** Passthrough for consumer mode, and for a copied-out demo with no source beside it. */
const PASSTHROUGH = { readPackage: (pkg) => pkg };

function resolveHooks() {
  if (!LINK || !fs.existsSync(sharedHookPath) || !fs.existsSync(packagesRoot)) return PASSTHROUGH;

  const shared = require(sharedHookPath);
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
