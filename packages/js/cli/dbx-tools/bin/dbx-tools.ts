#!/usr/bin/env node
/**
 * Databricks runtime CLI entry point.
 */
import { runCli } from "../src/cli.ts";

runCli(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
