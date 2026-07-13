/**
 * `dbxtools clean`: enumerate the workspace's generated files and delete a chosen
 * subset. This is the pure filesystem half; the interactive picker (a `@clack/prompts`
 * multiselect, all preselected) lives in the CLI (`bin/dbxtools.ts`).
 *
 * "Generated" is detected structurally, not by a hardcoded list: every file this
 * toolchain writes is set READ-ONLY (projen's own config + the barrelsby barrels; see
 * {@link isReadonly}), while every hand-authored source stays writable. So a read-only
 * file under the repo - skipping vendor/build/VCS dirs, but INCLUDING `.projen` - is a
 * generated file and a clean target.
 *
 * Nothing here is destructive to the ability to regenerate: `.projenrc.ts` imports the
 * engine by SOURCE path (`workspaces/cli/dbx-tools/src/...`), so even after deleting
 * every barrel, manifest, and `.projen/*`, `npx tsx .projenrc.ts` (and thus
 * `pnpm exec projen`) still rebuilds the whole tree.
 */
import { rmSync } from "node:fs";
import { relative } from "node:path";
import { isReadonly, makeWritable } from "./generated";
import { IGNORE_DIRS, repoRoot, toPosix, walkFiles } from "./workspace";

/**
 * Dir names `clean` must never descend into (vendored, build output, VCS). This is
 * {@link IGNORE_DIRS} minus `.projen`: unlike discovery, a clean SHOULD reach the
 * generated task/dep manifests projen keeps under `.projen/`.
 */
const CLEAN_IGNORE_DIRS: ReadonlySet<string> = new Set(
  [...IGNORE_DIRS].filter((d) => d !== ".projen"),
);

/**
 * Every generated (read-only) file in the workspace, as absolute paths sorted by
 * repo-relative posix path. Vendor/build/VCS dirs are skipped; `.projen/*` is included.
 */
export function listGeneratedFiles(root: string = repoRoot): string[] {
  const rel = (f: string): string => toPosix(relative(root, f));
  return walkFiles(root, CLEAN_IGNORE_DIRS)
    .filter(isReadonly)
    .sort((a, b) => rel(a).localeCompare(rel(b)));
}

/**
 * Delete the given files, clearing the read-only bit first so it also works on
 * Windows (where a read-only file can't be unlinked). Missing files are ignored (a
 * racing watcher may have already removed one). Returns the count actually removed.
 */
export function removeFiles(files: readonly string[]): number {
  let removed = 0;
  for (const file of files) {
    try {
      makeWritable(file);
      rmSync(file, { force: true });
      removed++;
    } catch {
      // Already gone, or racing the watcher - nothing to do.
    }
  }
  return removed;
}
