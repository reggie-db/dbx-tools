#!/usr/bin/env -S npx tsx
import { resolve } from "node:path";
import { logger } from "../src/log";
import { runSynth } from "../src/scaffold";
import { watchLoop } from "../src/watch";
import { repoRoot } from "../src/workspace";

const log = logger.withTag("projen:projenrc");

/** The consumer's projen manifest - the only file that drives a full re-synth. */
const PROJENRC = resolve(repoRoot, ".projenrc.ts");

// Watch-only: `sync --watch` runs this under `concurrently` as the intelligent
// re-synth trigger. It watches ONLY `.projenrc.ts` and re-synths (+install) on edit -
// scoping re-synth (the one expensive, install-bearing step) to the manifest is what
// makes the watch intelligent vs stock `projen --watch`, which re-synths on any tree
// change. `{ dot: false }` keeps the default dotfile ignore group from pruning our
// lone dotfile target. (A one-shot "projenrc" is just a synth, i.e. `pnpm exec projen`.)
watchLoop(
  "projenrc",
  [PROJENRC],
  () => {
    log.start("projenrc changed - re-synthesizing (+install)");
    runSynth({ post: true });
    log.success("re-synth complete");
  },
  { dot: false },
);
