#!/usr/bin/env -S bun
import { main } from "./lib/compile-workspace.ts";

export { compilePlan, main } from "./lib/compile-workspace.ts";

if (import.meta.main) await main();
