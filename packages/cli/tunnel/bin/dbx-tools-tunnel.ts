#!/usr/bin/env node
/**
 * `dbx-tools-tunnel` / `dbxt-tunnel` entry: front a Databricks App with a public
 * portr tunnel + email-OTP gate, wrapping the start command after `--`.
 * Delegates to the commander program in `../src/cli`.
 */
import { CommanderError, runCli } from "../src/cli.ts";

runCli(process.argv).catch((err: unknown) => {
  if (err instanceof CommanderError) process.exit(err.exitCode);
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
