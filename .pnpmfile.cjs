/**
 * This repo's pnpm `readPackage` hook, plus the shared factory the sibling
 * workspaces build theirs from.
 *
 * TWO jobs, because a pnpmfile is per-INSTALL. pnpm loads `.pnpmfile.cjs` from
 * the root of the install it is performing, so `projen/` and `demo/` (each its
 * own workspace, with its own lockfile and store) never see this file as a hook.
 * They `require` it instead and call {@link createLinkHook}, which is why the
 * link-rewriting logic lives here once rather than three times.
 *
 * This workspace's own job: link the projen engine (`@dbx-tools/projen`) from
 * the in-repo `projen/` project instead of a registry. The engine used to be
 * dogfooded as a workspace package, which created a bootstrap cycle (the root's
 * synth depends on the engine it builds). It now lives in the standalone
 * `projen/` project, deliberately NOT a member of this workspace, so the
 * dependency has to be rewritten to a local `link:`. The engine's own
 * `@dbx-tools/*` utility deps resolve as normal workspace members here and need
 * no rewrite.
 *
 * When the packages are published, drop the callers (or point their maps at the
 * registry versions).
 *
 * @module
 */
const fs = require("node:fs");
const path = require("node:path");

/**
 * Every manifest field that can carry a dependency, so a package is linked no
 * matter how it was declared. `optionalDependencies` entries are also mirrored
 * into `dependencies` by npm convention, but rewriting both is harmless and
 * means a caller never has to think about which field a dep landed in.
 */
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** Parse a JSON file, or return `undefined` when it is missing / malformed. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * A `link:` specifier for `target`, expressed RELATIVE to `base`.
 *
 * Relative is not a style choice. pnpm records a specifier verbatim in the
 * lockfile, so an absolute one pins that lockfile to a single machine's home
 * directory and every install elsewhere fails `ERR_PNPM_OUTDATED_LOCKFILE`
 * comparing `link:/Users/<someone>/...` against `link:/home/runner/...`.
 */
function linkSpecifier(base, target) {
  const rel = path.relative(base, target).split(path.sep).join("/");
  return `link:${rel.startsWith(".") ? rel : `./${rel}`}`;
}

/**
 * Build a `readPackage` hook that rewrites in-scope dependencies to local
 * `link:` paths.
 *
 * There is no include / exclude list. `sources` is the set of packages that
 * EXIST locally (normally straight from {@link scanPackages}), and a dependency
 * is rewritten whenever it appears in that set. A caller therefore declares
 * where the source lives, not which packages to link, so a package added,
 * removed, or renamed needs no edit anywhere.
 *
 * @param caller  The calling pnpmfile's `__filename`. Its directory is the
 *                workspace root, which is the DEFAULT base a relative specifier
 *                resolves against - see `baseFor` for why that matters.
 * @param sources `Map`/object of `depName -> absoluteSourceDir`. Anything present
 *                here is linked; anything else is left alone.
 * @param baseFor Optional `(pkgName) => baseDir | undefined`. The directory this
 *                package's relative specifiers resolve from, or `undefined` to
 *                leave the package entirely alone. Defaults to the workspace root
 *                for every package.
 *
 *                pnpm uses two different bases and getting them confused is the
 *                one real hazard here. A dependency of a workspace MEMBER
 *                resolves against that member's own directory, while a
 *                dependency of a transitively-linked package resolves against
 *                the directory holding `pnpm-lock.yaml` (the workspace root),
 *                because that is what lockfile paths are relative to. Using a
 *                linked package's own directory for it yields
 *                `Installing a dependency from a non-existent directory`.
 *
 *                The default therefore suits a workspace whose only importers
 *                are at the root; a caller with real members that take these
 *                deps must pass `baseFor`.
 * @returns `{ readPackage }`, ready to use as the pnpmfile's `hooks`.
 */
function createLinkHook({ caller, sources, baseFor }) {
  const workspaceRoot = path.dirname(caller);
  const resolveBase = baseFor ?? (() => workspaceRoot);
  const targets = sources instanceof Map ? sources : new Map(Object.entries(sources ?? {}));

  return {
    readPackage(pkg) {
      if (targets.size === 0) return pkg;
      const base = resolveBase(pkg.name);
      if (!base) return pkg;
      for (const field of DEP_FIELDS) {
        const deps = pkg[field];
        if (!deps) continue;
        for (const name of Object.keys(deps)) {
          const target = targets.get(name);
          if (target) deps[name] = linkSpecifier(base, target);
        }
      }
      return pkg;
    },
  };
}

/**
 * Map every package under `roots` whose name carries `scope` to its absolute
 * directory, by reading manifests off disk. Accepts one directory or several;
 * missing directories are skipped, so a caller can name optional locations.
 *
 * The name cannot be derived from the path: `@dbx-tools/appkit-mastra` lives at
 * `packages/node/appkit-mastra` (tier dropped) while `@dbx-tools/shared-core` is
 * at `packages/shared/core` (tier kept), so the manifest is the only source of
 * truth. Reading them is also what lets {@link createLinkHook} need no include /
 * exclude list: whatever is on disk is what gets linked.
 */
function scanPackages(roots, scope) {
  const found = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "lib" || entry.name === ".git") continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name === "package.json") {
        const name = readJson(child)?.name;
        if (typeof name === "string" && name.startsWith(scope)) {
          found.set(name, path.dirname(child));
        }
      }
    }
  };
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    if (fs.existsSync(root)) walk(root);
  }
  return found;
}

/** The in-scope dependency names a manifest declares, across every dep field. */
function scopedDeps(manifest, scope) {
  const names = new Set();
  for (const field of DEP_FIELDS) {
    for (const name of Object.keys(manifest?.[field] ?? {})) {
      if (name.startsWith(scope)) names.add(name);
    }
  }
  return names;
}

/**
 * Narrow `sources` to the packages reachable from `entryNames`, following each
 * package's own in-scope deps. Same `Map` shape {@link createLinkHook} takes.
 *
 * Only needed when a workspace must link LESS than what is on disk. The demo is
 * the one such case: its client runs from source while its server stays on the
 * registry, because a linked server package would resolve its own
 * `@databricks/appkit` from the main repo's tree and break AppKit's singletons.
 */
function dependencyClosure(entryNames, sources, scope) {
  const reached = new Map();
  const queue = [...entryNames];
  while (queue.length > 0) {
    const name = queue.shift();
    const dir = sources.get(name);
    if (!dir || reached.has(name)) continue;
    reached.set(name, dir);
    for (const dep of scopedDeps(readJson(path.join(dir, "package.json")), scope)) {
      if (!reached.has(dep)) queue.push(dep);
    }
  }
  return reached;
}

/** npm scope every package in this project shares, including the trailing slash. */
const SCOPE = "@dbx-tools/";

module.exports = {
  /**
   * This workspace's own hook. Only `projen/` needs scanning: everything under
   * `packages/` is already a member of this workspace, so pnpm links those from
   * their `workspace:*` specifiers without help, and rewriting them would take
   * that away from it for no gain.
   */
  hooks: createLinkHook({
    caller: __filename,
    sources: scanPackages(path.join(__dirname, "projen"), SCOPE),
  }),
  // Shared surface for the sibling workspaces' pnpmfiles.
  SCOPE,
  createLinkHook,
  scanPackages,
  scopedDeps,
  dependencyClosure,
  readJson,
};
