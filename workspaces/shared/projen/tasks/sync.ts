#!/usr/bin/env -S npx tsx
import { logger } from "../src/log";
import { runSynth } from "../src/scaffold";
import { startWatch } from "../src/watch";

const watch = process.argv.includes("--watch");
const log = logger.withTag("projen:sync");

log.start("synthesizing");
runSynth({ post: true });
log.success("synced");

if (watch) startWatch();
