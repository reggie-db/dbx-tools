/**
 * Scaffold helpers: decide when a re-synth is due, and run it.
 *
 * `configureProject` discovers packages by scanning the filesystem at synth and
 * records them in `pnpm-workspace.yaml` (the source of truth). During `watch`,
 * the one-shot `dbxtools sync` compares the live filesystem against that record
 * to decide whether the package SET changed (a package was added/removed) and a
 * full re-synth is needed - versus a content edit, where only barrels rebuild.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { recordedRoots, repoRoot, scanPackages, workspacePackages } from "./workspace";

/** Member paths that currently exist on disk (scan of the recorded roots). */
export function currentPackages(): string[] {
  return scanPackages(repoRoot, recordedRoots()).map((p) => p.memberPath);
}

/** Member paths recorded by the last synth (read from `pnpm-workspace.yaml`). */
export function recordedPackages(): string[] {
  return workspacePackages(repoRoot).map((p) => p.path);
}

/** True if the set of package folders on disk differs from the recorded set. */
export function packageSetChanged(): boolean {
  const now = currentPackages();
  const then = recordedPackages();
  return now.length !== then.length || now.some((d, i) => d !== then[i]);
}

/**
 * Re-run projen synth by executing `.projenrc.ts` with `node --import tsx` (no
 * projen network re-exec).
 *
 * `post: true` runs the full flow - projen's post-synth `pnpm install` AND the
 * post-synth barrels component - which is what the one-shot `dbxtools sync`
 * wants. The default (`post: false`) sets `PROJEN_DISABLE_POST`, skipping both so
 * the watch loop stays fast; there the caller rebuilds barrels explicitly.
 *
 * Deliberately never forces `CI: "true"` here: besides pnpm's own no-TTY prompt,
 * `CI` also makes pnpm choose a `--frozen-lockfile` install for a MULTI-package
 * workspace's subprojects, which is the wrong tradeoff for routine re-synths (a
 * newly added/edited package's lockfile entry is expected to be behind). Where a
 * caller genuinely needs the no-TTY prompt answered non-interactively (only
 * `bootstrapWorkspace`, on a workspace with no subprojects yet), it runs with
 * `post: false` and does its own install afterward instead.
 */
export function runSynth(options: { post?: boolean } = {}): void {
  const env = { ...process.env };
  if (options.post) delete env.PROJEN_DISABLE_POST;
  else env.PROJEN_DISABLE_POST = "true";
  execFileSync(process.execPath, ["--import", "tsx", join(repoRoot, ".projenrc.ts")], {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });
}
