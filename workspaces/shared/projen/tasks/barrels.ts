#!/usr/bin/env -S npx tsx
import { generateBarrels } from "../src/barrels";
import { logger } from "../src/log";
import { startBarrelWatch } from "../src/watch";

const log = logger.withTag("projen:barrels");

if (process.argv.includes("--watch")) {
  startBarrelWatch();
} else {
  const n = generateBarrels();
  log.success(n === 0 ? "barrels already up to date" : `updated ${n} barrel${n === 1 ? "" : "s"}`);
}
