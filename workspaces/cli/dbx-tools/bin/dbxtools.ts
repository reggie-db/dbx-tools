#!/usr/bin/env -S npx tsx
/**
 * `dbxtools` bootstraps uninitialized workspaces, then forwards to projen.
 */
import { runCli } from "../src/cli";

runCli(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
