#!/usr/bin/env -S bun
/** Print shared-core runtime-export usage by caller kind. */
import { runTaskMain } from "./cli.ts";
import { formatSharedCoreUsage, sharedCoreExportUsage } from "../src/shared-core-usage.ts";

export function main(): void {
  process.stdout.write(formatSharedCoreUsage(sharedCoreExportUsage()));
}

await runTaskMain(import.meta, main);
