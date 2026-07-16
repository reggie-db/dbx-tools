#!/usr/bin/env -S npx tsx
import { generateOpenapi } from "../src/openapi";
import { runSynth } from "../src/scaffold";
import { startOpenapiWatch } from "../src/watch";

if (process.argv.includes("--watch")) {
  // Watch mode: regenerate on controller edits only; `projen --watch` (running
  // alongside under `concurrently`) owns re-synth of the generated packages.
  startOpenapiWatch();
} else {
  const dirs = await generateOpenapi();
  if (dirs.length > 0) runSynth({ post: true });
}
