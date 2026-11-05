#!/usr/bin/env bun

import { runCliMain } from "../src/_cli-main.ts";
import { buildProgram } from "../src/graphiti/cli.ts";

await runCliMain(() => buildProgram("dbx-graphiti").parseAsync(process.argv));
