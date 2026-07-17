#!/usr/bin/env -S npx tsx
/**
 * `model-proxy` entry: a local OpenAI-compatible proxy in front of Databricks
 * Model Serving. Delegates to the commander program in `../src/cli`.
 */
import { CommanderError, runCli } from "../src/cli";

runCli(process.argv).catch((err: unknown) => {
  if (err instanceof CommanderError) process.exit(err.exitCode);
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
