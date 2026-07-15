#!/usr/bin/env -S npx tsx
import { generateBarrels } from "../src/barrels";
import { logger } from "dbx-tools/log";

const log = logger.withTag("projen:barrels");
const n = generateBarrels();
log.success(n === 0 ? "barrels already up to date" : `updated ${n} barrel${n === 1 ? "" : "s"}`);
