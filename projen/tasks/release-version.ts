#!/usr/bin/env -S bun
import { main } from "./lib/release-version.ts";

export * from "./lib/release-version.ts";

if (import.meta.main) main();
