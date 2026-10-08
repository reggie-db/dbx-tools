#!/usr/bin/env -S bun
/** Print shared-core runtime-export usage by caller kind. */
import { formatSharedCoreUsage, sharedCoreExportUsage } from "../src/shared-core-usage.ts";

process.stdout.write(formatSharedCoreUsage(sharedCoreExportUsage()));
