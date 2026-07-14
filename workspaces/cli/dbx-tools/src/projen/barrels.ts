/**
 * Barrel generator, driven by barrelsby.
 *
 * For every package it writes a single `index.ts` **at the package root** (above
 * `src/`) that flat-re-exports every module under `src/`, subject to two rules:
 *   1. a file/folder whose name starts with `_` is private and never barrelled;
 *   2. only files that actually contain an `export` are re-exported.
 *
 * barrelsby can only write inside the directory it scans, so we let it write a
 * temporary `src/index.ts`, then relocate it to `<pkg>/index.ts` and rewrite the
 * now-one-level-deeper module paths (`./x` -> `./src/x`). The result gets an
 * optional caller {@link BarrelModifier}, then a do-not-edit header + read-only
 * bit (see `./generated`). barrelsby is resolved via its own package, so this
 * works both in-repo and when installed from npm.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { header, makeReadonly, makeWritable, stampGenerated, type HeaderOpts } from "./generated";
import { logger } from "../log";
import {
  escapeRegExp,
  hasExport,
  isModuleFile,
  repoRoot,
  toPosix,
  walkFiles,
  workspacePackages,
} from "./workspace";

const log = logger.withTag("projen:barrels");
const require = createRequire(import.meta.url);

// barrelsby is CLI-only (its package `main` is missing), so run its bin with node.
// Resolved lazily (not at module load) so importing this module during synth does
// not require barrelsby to be installed yet.
let barrelsbyCli: string | undefined;
function barrelsbyBin(): string {
  return (barrelsbyCli ??= require.resolve("barrelsby/bin/cli.js"));
}

/** Transform applied to a package's barrel contents before it is written. */
export type BarrelModifier = (content: string, ctx: { readonly packageDir: string }) => string;

/**
 * The do-not-edit banner stamped on every generated barrel. Deliberately stable
 * (no timestamp) so a barrel is a pure function of its exporting modules - which
 * is what lets {@link generateForPackage} skip the rewrite when nothing changed.
 */
const BARREL_HEADER: HeaderOpts = {
  tool: "projen watch (barrelsby)",
  source: "the exporting modules in ./src",
};

/**
 * Rebuild one package's root barrel. Returns 1 only if the barrel's contents
 * actually changed - a module was added, removed, renamed, or toggled its
 * `export` - and 0 for a no-op. An edit *inside* an already-exported module (even
 * adding a new named export) leaves the flat `export * from "./src/x"` list
 * identical, so it is a no-op.
 */
function generateForPackage(pkgDir: string, modifier?: BarrelModifier): number {
  const srcDir = join(pkgDir, "src");
  if (!existsSync(srcDir)) return 0;

  const rootBarrel = join(pkgDir, "index.ts");
  const tmpBarrel = join(srcDir, "index.ts");
  // Snapshot the current barrel so we can tell a real change (module added/removed/
  // renamed) from an edit *inside* an already-exported module, which leaves the flat
  // `export * from "./src/x"` list - and therefore this file - byte-for-byte identical.
  const before = existsSync(rootBarrel) ? readFileSync(rootBarrel, "utf8") : undefined;

  // Rule 2: src files with no export are excluded by exact (tail-anchored) path.
  const noExport = walkFiles(srcDir)
    .filter(isModuleFile)
    .filter((f) => !hasExport(f))
    .map((f) => `${escapeRegExp(toPosix(relative(srcDir, f)))}$`);

  // Unlock the read-only barrels so barrelsby's --delete / our rewrite can run.
  makeWritable(rootBarrel);
  makeWritable(tmpBarrel);

  const excludes = [
    "(^|/)_", // rule 1: any path segment starting with `_`
    "\\.(test|spec)\\.", // test files
    "\\.d\\.ts$", // declaration files
    ...noExport,
  ];
  const args = [
    barrelsbyBin(),
    "--directory",
    srcDir,
    "--location",
    "top", // one barrel at the src root...
    "--structure",
    "flat", // ...flat `export * from "./x"` for the whole subtree
    "--delete", // remove the stale barrel first
    "--noHeader", // we add our own do-not-edit header when stamping
    ...excludes.flatMap((e) => ["--exclude", e]),
  ];
  try {
    execFileSync(process.execPath, args, { cwd: repoRoot, stdio: "pipe" });
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? `${(err as { stderr?: Buffer }).stderr ?? ""}`
        : "";
    log.error(`barrelsby failed for ${toPosix(relative(repoRoot, srcDir))}`, stderr);
    throw err;
  }

  // No eligible modules -> no barrel: drop any stale root barrel and bail.
  if (!existsSync(tmpBarrel)) {
    if (existsSync(rootBarrel)) {
      makeWritable(rootBarrel);
      rmSync(rootBarrel, { force: true });
    }
    return 0;
  }

  // Relocate src/index.ts -> <pkg>/index.ts, deepening the module paths by one.
  let content = readFileSync(tmpBarrel, "utf8").replace(/from "\.\//g, 'from "./src/');
  rmSync(tmpBarrel, { force: true });
  if (modifier) content = modifier(content, { packageDir: pkgDir });

  // barrelsby regenerates on every source edit, but the barrel only *changes* when
  // its set of exporting modules does. If the stamped result matches what's already
  // on disk, restore the read-only bit we cleared above and report no change (0) -
  // this is what keeps the watcher quiet on ordinary in-file edits.
  const next = `${header(BARREL_HEADER)}\n${content}`;
  if (before === next) {
    makeReadonly(rootBarrel);
    return 0;
  }

  writeFileSync(rootBarrel, content);
  stampGenerated(rootBarrel, BARREL_HEADER);
  return 1;
}

/**
 * Rebuild barrels for the given package dirs (default: every package recorded in
 * `pnpm-workspace.yaml` - the source of truth, read via `workspacePackages()`).
 * Returns the number of barrels whose contents actually changed (an unchanged
 * export surface is a no-op), so callers can stay quiet when nothing moved.
 */
export function generateBarrels(opts: { dirs?: string[]; modifier?: BarrelModifier } = {}): number {
  const dirs = opts.dirs ?? workspacePackages().map((p) => p.dir);
  let total = 0;
  for (const dir of dirs) total += generateForPackage(dir, opts.modifier);
  return total;
}
