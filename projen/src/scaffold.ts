/**
 * Runs a projen re-synth, for the `sync` task and its watchers.
 */
import { join } from "node:path";
import { exec } from "@dbx-tools/core";
import { repoRoot } from "./packages.ts";

/**
 * Re-run projen synth by executing `.projenrc.ts` with `node --import tsx` (no
 * projen network re-exec).
 *
 * `post: true` runs the full flow - projen's post-synth `bun install` AND the
 * post-synth barrels component - which is what the one-shot `sync` task
 * wants. The default (`post: false`) sets `PROJEN_DISABLE_POST`, skipping both so
 * the watch loop stays fast; there the caller rebuilds barrels explicitly.
 *
 * Deliberately never forces `CI: "true"` here: besides pnpm's own no-TTY prompt,
 * `CI` also makes pnpm choose a `--frozen-lockfile` install for a MULTI-package
 * workspace's subprojects, which is the wrong tradeoff for routine re-synths (a
 * newly added/edited package's lockfile entry is expected to be behind). A caller
 * that needs the no-TTY prompt answered non-interactively (the `dbx-tools` CLI, when
 * bootstrapping an empty folder) runs with `post: false` and does its own install
 * afterward instead.
 */
export function runSynth(options: { post?: boolean } = {}): void {
  const env = { ...process.env };
  if (options.post) delete env.PROJEN_DISABLE_POST;
  else env.PROJEN_DISABLE_POST = "true";
  exec.spawnSync(process.execPath, ["--import", "tsx", join(repoRoot, ".projenrc.ts")], {
    cwd: repoRoot,
    env,
    check: true,
  });
}
