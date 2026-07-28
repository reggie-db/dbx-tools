#!/usr/bin/env node
/**
 * `dbx-tools` bootstraps uninitialized workspaces, then forwards to projen.
 */
import { runCli } from "../src/cli.ts";

runCli(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
