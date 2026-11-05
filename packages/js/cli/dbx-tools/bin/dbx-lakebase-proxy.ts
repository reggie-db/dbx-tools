#!/usr/bin/env node
import { runCliMain } from "../src/_cli-main.ts";
import { buildProgram } from "../src/lakebase-proxy/cli.ts";

await runCliMain(() => buildProgram("dbx-lakebase-proxy").parseAsync(process.argv));
