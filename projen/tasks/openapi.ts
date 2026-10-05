#!/usr/bin/env -S bun
import { log, object, stringUtils } from "@dbx-tools/shared-core";
import { generateBarrels } from "../src/barrels.ts";
import { generateOpenapi, isOpenapiSource, openapiWatchRoots } from "../src/openapi.ts";
import { runSynth } from "../src/scaffold.ts";
import { watchLoop } from "../src/watch.ts";

const logger = log.logger("projen:openapi");

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.includes("--watch")) {
    // Watch the package roots; a changed tsoa controller regenerates the openapi
    // packages (spec + client) and rebuilds just their barrels. The projenrc watcher
    // (alongside under `concurrently`) owns full re-synth, so no re-synth here.
    watchLoop(
      "openapi",
      openapiWatchRoots(),
      async () => {
        const dirs = await generateOpenapi();
        if (dirs.length) {
          generateBarrels({ dirs });
          logger.success(`regenerated openapi (${stringUtils.pluralize(dirs.length, "package")})`);
        }
      },
      { check: (changed) => object.sequence(changed).some(isOpenapiSource) },
    );
  } else {
    // One-shot: regenerate, then re-synth so any newly created openapi folder becomes a
    // workspace member (a new package needs install + linking, which the watch path skips).
    const dirs = await generateOpenapi();
    if (dirs.length > 0) runSynth({ post: true });
  }
}

if (import.meta.main) await main();
