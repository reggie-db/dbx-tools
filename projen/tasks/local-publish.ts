#!/usr/bin/env -S bun
import { main } from "./lib/local-publish.ts";

export * from "./lib/local-publish.ts";

if (import.meta.main) await main();
