#!/usr/bin/env -S bun
import { main } from "./lib/publish.ts";

export { applyPublishConfig, main } from "./lib/publish.ts";

if (import.meta.main) await main();
