#!/usr/bin/env -S npx tsx
/**
 * `dbxtools` forwards to projen. All workspace tooling (barrels, openapi, sync,
 * clean, watch) is registered as native projen tasks on the monorepo root.
 *
 *   pnpm dbxtools              # same as `pnpm exec projen` (synth)
 *   pnpm dbxtools sync --watch # re-synth + watch loop
 *   pnpm dbxtools barrels      # rebuild package barrels
 *   pnpm dbxtools openapi      # generate openapi client packages
 *   pnpm dbxtools clean -y     # remove generated files + node_modules
 */
import { runPnpm } from "../src/bin";

runPnpm(["exec", "projen", ...process.argv.slice(2)]);
