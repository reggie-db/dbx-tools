#!/usr/bin/env -S bun
import { main } from "./lib/publish-npm.ts";

export * from "./lib/publish-npm.ts";

if (import.meta.main) await main();
