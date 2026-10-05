#!/usr/bin/env -S bun
import { main } from "./lib/python-node-bindings.ts";

export { main } from "./lib/python-node-bindings.ts";

if (import.meta.main) await main();
