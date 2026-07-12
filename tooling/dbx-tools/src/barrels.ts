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
import { makeWritable, stampGenerated } from "./generated";
import { logger } from "./log";
import {
  discoverPackagesOnDisk,
  escapeRegExp,
  hasExport,
  isModuleFile,
  repoRoot,
  toPosix,
  walkFiles,
} from "./workspace";

const log = logger.withTag("projen:barrels");
const require = createRequire(import.meta.url);
// barrelsby is CLI-only (its package `main` is missing), so run its bin with node.
const BARRELSBY_CLI = require.resolve("barrelsby/bin/cli.js");

/** Transform applied to a package's barrel contents before it is written. */
export type BarrelModifier = (
  content: string,
  ctx: { readonly packageDir: string },
) => string;

/** Rebuild the root barrel for one package dir; returns 1 if one was written. */
function generateForPackage(pkgDir: string, modifier?: BarrelModifier): number {
  const srcDir = join(pkgDir, "src");
  if (!existsSync(srcDir)) return 0;

  const rootBarrel = join(pkgDir, "index.ts");
  const tmpBarrel = join(srcDir, "index.ts");

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
    BARRELSBY_CLI,
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

  writeFileSync(rootBarrel, content);
  stampGenerated(rootBarrel, {
    tool: "projen watch (barrelsby)",
    source: "the exporting modules in ./src",
  });
  return 1;
}

/** Rebuild barrels for the given package dirs (default: all packages). */
export function generateBarrels(
  opts: { dirs?: string[]; modifier?: BarrelModifier } = {},
): number {
  const dirs = opts.dirs ?? discoverPackagesOnDisk().map((p) => p.dir);
  let total = 0;
  for (const dir of dirs) total += generateForPackage(dir, opts.modifier);
  return total;
}
