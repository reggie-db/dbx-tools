#!/usr/bin/env -S npx tsx
import { generateBarrels } from "../src/barrels";
import { logger, pluralize } from "../src/log";
import { generateOpenapi, isTsoaController } from "../src/openapi";
import { runSynth } from "../src/scaffold";
import { watchLoop, watchRoots } from "../src/watch";

const log = logger.withTag("projen:openapi");

if (process.argv.includes("--watch")) {
  // Watch the package roots; a changed tsoa controller regenerates the openapi
  // packages (spec + client) and rebuilds just their barrels. The projenrc watcher
  // (alongside under `concurrently`) owns full re-synth, so no re-synth here.
  watchLoop("openapi", watchRoots(), async (changed) => {
    if (!changed.some(isTsoaController)) return;
    const dirs = await generateOpenapi();
    if (dirs.length) {
      generateBarrels({ dirs });
      log.success(`regenerated openapi (${pluralize(dirs.length, "package")})`);
    }
  });
} else {
  // One-shot: regenerate, then re-synth so any newly created openapi folder becomes a
  // workspace member (a new package needs install + linking, which the watch path skips).
  const dirs = await generateOpenapi();
  if (dirs.length > 0) runSynth({ post: true });
}
