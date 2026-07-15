#!/usr/bin/env -S npx tsx
import { needsBootstrap, bootstrapWorkspace } from "../src/bootstrap";
import { runSynth } from "../src/scaffold";
import { startWatch } from "../src/watch";
import { logger } from "../src/log";

const watch = process.argv.includes("--watch");
const log = logger.withTag("projen:sync");

if (needsBootstrap()) {
  bootstrapWorkspace();
} else {
  log.start("synthesizing");
  runSynth({ post: true });
  log.success("synced");
}

if (watch) startWatch();
