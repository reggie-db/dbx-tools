#!/usr/bin/env -S npx tsx
import { generateBarrels } from "../src/barrels";
import { generateCodegen, isCodegenInput } from "../src/codegen";
import { logger, pluralize } from "../src/log";
import { runSynth } from "../src/scaffold";
import { watchLoop, watchRoots } from "../src/watch";

const log = logger.withTag("projen:codegen");

if (process.argv.includes("--watch")) {
  // Watch the package roots; a changed codegen input regenerates the generated/
  // trees and rebuilds just their barrels. The projenrc watcher (alongside under
  // `concurrently`) owns full re-synth, so no re-synth here.
  watchLoop("codegen", watchRoots(), async (changed) => {
    if (!changed.some(isCodegenInput)) return;
    const dirs = generateCodegen();
    if (dirs.length) {
      generateBarrels({ dirs });
      log.success(`regenerated codegen (${pluralize(dirs.length, "package")})`);
    }
  });
} else {
  // One-shot: regenerate, then re-synth so a newly created generated/ tree is
  // picked up (install + linking, which the watch path skips).
  const dirs = generateCodegen();
  if (dirs.length > 0) runSynth({ post: true });
}
