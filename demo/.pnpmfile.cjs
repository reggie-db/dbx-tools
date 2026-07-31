/**
 * Resolve the demo SERVER and CLIENT to the local source workspace.
 *
 * The demo is a real downstream CONSUMER, so installing published versions is a
 * mode it has to keep. It is not the DEFAULT one, though: beside the packages in
 * this checkout, the common case is editing them, and a demo silently running a
 * published copy of the code you just changed is the more expensive surprise -
 * you restart, see the old behavior, and go looking for the bug in the wrong
 * place. So linking is on unless you opt out:
 *
 *   pnpm install                     # server + client resolve local source
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
 * Linking only `@dbx-tools/*` is insufficient on the SERVER. Node follows each
 * link to the main repo's real source directory, where imports resolve from the
 * MAIN `node_modules`; meanwhile imports written directly in the demo would
 * resolve from `demo/node_modules`. AppKit's `CacheManager`, Mastra classes,
 * React contexts, and other identity-bearing modules would then exist twice.
 * The root hook's `resolvedDependencySources()` bridges every external
 * dependency declared by the source packages to the SAME package instance from
 * the main install. The demo members, linked dbx-tools sources, and their shared
 * runtime therefore form one module graph even though `demo/` remains a
 * standalone pnpm workspace.
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
const sharedHookPath = path.join(demoRoot, "..", ".pnpmfile.cjs");

/** Passthrough for consumer mode, and for a copied-out demo with no source beside it. */
const PASSTHROUGH = { readPackage: (pkg) => pkg };

function resolveHooks() {
  // Existence first, then the switch: a copied-out demo has no root hook to ask.
  if (!fs.existsSync(sharedHookPath) || !fs.existsSync(packagesRoot)) return PASSTHROUGH;

  const shared = require(sharedHookPath);
  if (!shared.linkEnabled()) return PASSTHROUGH;

  const sources = shared.scanPackages(packagesRoot, shared.SCOPE);
  if (sources.size === 0) return PASSTHROUGH;
  const runtimes = shared.resolvedDependencySources(sources, shared.SCOPE);
  const targets = new Map([...sources, ...runtimes]);
  const members = shared.scanPackages(
    [path.join(demoRoot, "app"), path.join(demoRoot, "server")],
    shared.SCOPE,
  );

  return shared.createLinkHook({
    caller: __filename,
    sources: targets,
    // A workspace member's relative links resolve from that member. Every linked
    // package's links are recorded relative to the demo lockfile at `demoRoot`.
    baseFor: (name) => members.get(name) ?? (targets.has(name) ? demoRoot : undefined),
  });
}

module.exports = { hooks: resolveHooks() };
