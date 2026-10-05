/**
 * The `clean` task (`bun run clean`): enumerate the workspace's generated files (plus every
 * `node_modules` directory) and delete a chosen subset. This is the pure filesystem
 * half - reusable enumerate/remove helpers; the task that drives them (argv `-y`, the
 * `@clack/prompts` multiselect picker with all preselected, the TTY guard) lives in
 * `tasks/clean.ts`, which forwards to these functions.
 *
 * Generated files come from Projen's `.projen/files.json` inventories plus the
 * durable header used by dynamic dbx-tools generators. File mode is edit
 * protection only and is never treated as ownership evidence.
 *
 * Deleting only generated files is never destructive to the ability to regenerate:
 * `.projenrc.ts` imports the engine by SOURCE path (relative into the repo, e.g.
 * `packages/node/projen/src/...`, or from an installed package such as
 * `@dbx-tools/projen`), so even after deleting every barrel, manifest, and
 * `.projen/*`, `bun run default` still rebuilds the whole tree. Removing `node_modules` additionally requires a
 * `bun install` first - the engine's runtime deps live there - so a clean that takes
 * `node_modules` must be followed by reinstall, then re-synth.
 */
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { find } from "@dbx-tools/path";
import { json } from "@dbx-tools/shared-core";
import { isGenerated, makeWritable } from "./generated.ts";
import { resolveRepoRoot, toPosix } from "./packages.ts";

/**
 * Basenames `clean` never removes even when they are generated/read-only. `.gitignore`
 * is hand-relevant git plumbing: nuking it would un-ignore `node_modules`/build output
 * on the very next tool run, so it is always kept.
 */
const CLEAN_SKIP_FILES: ReadonlySet<string> = new Set([".gitignore"]);

/**
 * Every generated file in the workspace, as absolute paths sorted by
 * repo-relative posix path. Skips vendor/build/VCS dirs via node-path's built-in
 * ignores AND every dot-prefixed folder (`.projen`, `.vscode`, `.github`, ...), and
 * {@link CLEAN_SKIP_FILES} entry (`.gitignore`).
 */
function nativeGeneratedFiles(root: string): string[] {
  const files = new Set<string>();
  for (const manifestPath of find.findFiles("**/.projen/files.json", {
    cwd: root,
    ignoreOptions: { dot: false },
  })) {
    const manifest = json.parseRecord(readFileSync(resolve(root, manifestPath), "utf8"));
    const projectRoot = dirname(dirname(resolve(root, manifestPath)));
    const entries = manifest?.files;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry === "string") files.add(resolve(projectRoot, entry));
    }
  }
  return [...files];
}

export function listGeneratedFiles(root: string = resolveRepoRoot()): string[] {
  const rel = (f: string): string => toPosix(relative(root, f));
  const custom = [...find.findFiles("**/*", { cwd: root })]
    .map((f) => join(root, f))
    .filter(isGenerated);
  return [...new Set([...nativeGeneratedFiles(root), ...custom])]
    .filter(existsSync)
    .filter(
      (file) =>
        !rel(file)
          .split("/")
          .some((part) => part.startsWith(".")),
    )
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
export function listNodeModulesDirs(root: string = resolveRepoRoot()): string[] {
  if (!existsSync(root)) return [];
  const rel = (f: string): string => toPosix(relative(root, f));
  return [...find.findFiles("**/node_modules", { cwd: root, ignoreOptions: { dot: false } })]
    .map((match) => join(root, match))
    .sort((a, b) => rel(a).localeCompare(rel(b)));
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
  const failures: unknown[] = [];
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue;
      if (statSync(path).isFile()) makeWritable(path);
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Could not remove ${failures.length} selected path(s)`);
  }
  return removed;
}
