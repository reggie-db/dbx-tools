#!/usr/bin/env -S bun
/** Print shared-core runtime-export usage by caller kind. */
import { runTaskMain } from "./cli.ts";
import { formatSharedCoreUsage, sharedCoreExportUsage } from "../src/shared-core-usage.ts";

export async function main(): Promise<void> {
  process.stdout.write(formatSharedCoreUsage(await sharedCoreExportUsage()));
}

await runTaskMain(import.meta, main);
