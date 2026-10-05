#!/usr/bin/env -S bun
import { main } from "./lib/publish-python.ts";

export * from "./lib/publish-python.ts";

if (import.meta.main) await main();
