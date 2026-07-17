#!/usr/bin/env -S npx tsx
import { resolve } from "node:path";
import { log } from "@dbx-tools/shared-core";
import { runSynth } from "../src/scaffold";
import { watchLoop } from "../src/watch";
import { repoRoot, syncResynthPaths } from "../src/workspace";

const logger = log.logger("projen:projenrc");

/** Repo-root paths that drive a full re-synth when they change during `sync --watch`. */
function resynthWatchPaths(): string[] {
  const paths = [resolve(repoRoot, ".projenrc.ts")];
  for (const rel of syncResynthPaths()) {
    const abs = resolve(repoRoot, rel);
    if (!paths.includes(abs)) paths.push(abs);
  }
  return paths;
}

const WATCH_PATHS = resynthWatchPaths();

// Watch-only: `sync --watch` runs this under `concurrently` as the intelligent
// re-synth trigger. It watches `.projenrc.ts` plus any `dbxToolsConfig.syncResynthPaths`
// entries (from the root's `syncResynthPaths` option) and re-synths (+install) on edit -
// scoping re-synth (the one expensive, install-bearing step) to those manifests is what
// makes the watch intelligent vs stock `projen --watch`, which re-synths on any tree
// change. `{ dot: false }` keeps the default dotfile ignore group from pruning dotfile
// targets. (A one-shot "projenrc" is just a synth, i.e. `pnpm exec projen`.)
watchLoop(
  "projenrc",
  WATCH_PATHS,
  () => {
    logger.start("projenrc changed - re-synthesizing (+install)");
    runSynth({ post: true });
    logger.success("re-synth complete");
  },
  { dot: false },
);
