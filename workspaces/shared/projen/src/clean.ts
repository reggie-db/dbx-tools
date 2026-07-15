/**
 * `dbxtools clean`: enumerate the workspace's generated files (plus every
 * `node_modules` directory) and delete a chosen subset. This is the pure filesystem
 * half; the interactive picker (a `@clack/prompts` multiselect, all preselected)
 * lives in the CLI (`bin/dbxtools.ts`).
 *
 * "Generated" is detected structurally, not by a hardcoded list: every file this
 * toolchain writes is set READ-ONLY (projen's own config + the barrelsby barrels; see
 * {@link isReadonly}), while every hand-authored source stays writable. So a read-only
 * file under the repo is a clean target - EXCEPT anything inside a dot-prefixed folder
 * (`.projen`, `.vscode`, `.git`, ...) and `.gitignore` itself, which clean always leaves
 * alone (projen re-syncs `.projen`/`.vscode` on the next synth). `node_modules` is
 * enumerated separately (see {@link listNodeModulesDirs}) as whole directories.
 *
 * Deleting only generated files is never destructive to the ability to regenerate:
 * `.projenrc.ts` imports the engine by SOURCE path (`workspaces/cli/dbx-tools/src/...`),
 * so even after deleting every barrel, manifest, and `.projen/*`, `pnpm exec projen`
 * still rebuilds the whole tree. Removing `node_modules` additionally requires a
 * `pnpm install` first - the engine's runtime deps live there - so a clean that takes
 * `node_modules` must be followed by reinstall, then re-synth.
 */
import { existsSync, rmSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { find } from "@dbx-tools/shared-file-scan";
import { isReadonly, makeWritable } from "./generated";
import { repoRoot, SCAN_EXTRA_IGNORE, toPosix, walkFiles } from "./workspace";

/**
 * Basenames `clean` never removes even when they are generated/read-only. `.gitignore`
 * is hand-relevant git plumbing: nuking it would un-ignore `node_modules`/build output
 * on the very next tool run, so it is always kept.
 */
const CLEAN_SKIP_FILES: ReadonlySet<string> = new Set([".gitignore"]);

/**
 * Every generated (read-only) file in the workspace, as absolute paths sorted by
 * repo-relative posix path. Skips vendor/build/VCS dirs via file-scan's built-in
 * ignores AND every dot-prefixed folder (`.projen`, `.vscode`, `.github`, ...), and
 * {@link CLEAN_SKIP_FILES} entry (`.gitignore`).
 */
export function listGeneratedFiles(root: string = repoRoot): string[] {
  const rel = (f: string): string => toPosix(relative(root, f));
  return walkFiles(root, undefined, (name) => name.startsWith("."))
    .filter(isReadonly)
    .filter((f) => !CLEAN_SKIP_FILES.has(basename(f)))
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
  const dirs = new Set<string>();
  for (const match of find.findFiles("**/node_modules", {
    cwd: root,
    ignore: [...SCAN_EXTRA_IGNORE],
    ignoreOptions: { dot: false },
  })) {
    dirs.add(join(root, match));
  }
  return [...dirs].sort((a, b) => rel(a).localeCompare(rel(b)));
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
