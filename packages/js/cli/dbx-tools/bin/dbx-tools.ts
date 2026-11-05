#!/usr/bin/env node
/**
 * `dbx-tools` bootstraps uninitialized workspaces, then forwards to projen.
 */
import { runCliMain } from "../src/_cli-main.ts";
import { runCli } from "../src/cli.ts";

await runCliMain(() => runCli(process.argv));
