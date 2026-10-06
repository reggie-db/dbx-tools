#!/usr/bin/env -S bun
import { main } from "./lib/release.ts";

export { createReleaseCommand, main, runRelease } from "./lib/release.ts";

if (import.meta.main) await main();
