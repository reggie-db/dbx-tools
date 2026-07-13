/**
 * `dbxtools clean`: enumerate the workspace's generated files (plus every
 * `node_modules` directory) and delete a chosen subset. This is the pure filesystem
 * half; the interactive picker (a `@clack/prompts` multiselect, all preselected)
 * lives in the CLI (`bin/dbxtools.ts`).
 *
 * "Generated" is detected structurally, not by a hardcoded list: every file this
 * toolchain writes is set READ-ONLY (projen's own config + the barrelsby barrels; see
 * {@link isReadonly}), while every hand-authored source stays writable. So a read-only
 * file under the repo - skipping vendor/build/VCS dirs, but INCLUDING `.projen` - is a
 * generated file and a clean target. `node_modules` is enumerated separately (see
 * {@link listNodeModulesDirs}) as whole directories rather than files.
 *
 * Deleting only generated files is never destructive to the ability to regenerate:
 * `.projenrc.ts` imports the engine by SOURCE path (`workspaces/cli/dbx-tools/src/...`),
 * so even after deleting every barrel, manifest, and `.projen/*`, `pnpm exec projen`
 * still rebuilds the whole tree. Removing `node_modules` additionally requires a
 * `pnpm install` first - the engine's runtime deps live there - so a clean that takes
 * `node_modules` must be followed by reinstall, then re-synth.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { isReadonly, makeWritable } from "./generated";
import { IGNORE_DIRS, repoRoot, toPosix, walkFiles } from "./workspace";

/**
 * Dir names `clean` must never descend into (vendored, build output, VCS). This is
 * {@link IGNORE_DIRS} minus `.projen`: unlike discovery, a clean SHOULD reach the
 * generated task/dep manifests projen keeps under `.projen/`.
 */
const CLEAN_IGNORE_DIRS: ReadonlySet<string> = new Set([
  ...[...IGNORE_DIRS].filter((d) => d !== ".projen")
]);


const CLEAN_IGNORE_FILES = ".gitignore"

/**
 * Every generated (read-only) file in the workspace, as absolute paths sorted by
 * repo-relative posix path. Vendor/build/VCS dirs are skipped; `.projen/*` is included.
 */
export function listGeneratedFiles(root: string = repoRoot): string[] {
  const rel = (f: string): string => toPosix(relative(root, f));
  return walkFiles(root, CLEAN_IGNORE_DIRS)
    .filter(isReadonly).filter(f => !CLEAN_IGNORE_FILES.includes(basename(f)))
    .sort((a, b) => rel(a).localeCompare(rel(b)));
}

/**
 * Every `node_modules` directory in the workspace (the root's plus each package's), as
 * absolute paths sorted by repo-relative posix path. The walk RECORDS a `node_modules`
 * dir but never descends into it, so a nested store/symlink `node_modules`
 * (`node_modules/.pnpm/x/node_modules`, a package's linked deps) is never listed on its
 * own - removing the top-level dir takes it along. Other vendor/build/VCS dirs are
 * skipped for speed.
 */
export function listNodeModulesDirs(root: string = repoRoot): string[] {
  if (!existsSync(root)) return [];
  const rel = (f: string): string => toPosix(relative(root, f));
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const d of readdirSync(cur, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const full = join(cur, d.name);
      if (d.name === "node_modules") out.push(full); // record; do NOT descend
      else if (!IGNORE_DIRS.has(d.name)) stack.push(full);
    }
  }
  return out.sort((a, b) => rel(a).localeCompare(rel(b)));
}

/**
 * Delete the given paths - generated files and/or whole directories (`node_modules`).
 * A regular file has its read-only bit cleared first (so unlink also works on Windows);
 * a directory is removed recursively and is NOT chmod'd (file mode `0o644` would strip
 * a dir's traversal bit and break the recursive delete). Missing paths are ignored (a
 * racing watcher may have already removed one). Returns the count actually removed.
 */
export function removePaths(paths: readonly string[]): number {
  let removed = 0;
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue;
      if (statSync(path).isFile()) makeWritable(path);
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Already gone, or racing the watcher - nothing to do.
    }
  }
  return removed;
}
