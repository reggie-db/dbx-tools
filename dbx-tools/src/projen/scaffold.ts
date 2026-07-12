/**
 * Scaffold helpers: decide when a re-synth is due, and run it.
 *
 * `configureProjen` discovers packages by scanning the filesystem at synth and
 * records them in `pnpm-workspace.yaml` (the source of truth). During `watch`,
 * the one-shot `dbxtools sync` compares the live filesystem against that record
 * to decide whether the package SET changed (a package was added/removed) and a
 * full re-synth is needed - versus a content edit, where only barrels rebuild.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { discoverPackages, recordedEnvRoots, repoRoot } from "./workspace";

/** Member paths that currently exist on disk (scan of the recorded env roots). */
export function currentPackages(): string[] {
  return discoverPackages(repoRoot, recordedEnvRoots()).map((p) => p.memberPath);
}

/** Member paths recorded by the last synth (read from `pnpm-workspace.yaml`). */
export function recordedPackages(): string[] {
  return discoverPackages(repoRoot).map((p) => p.memberPath);
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
