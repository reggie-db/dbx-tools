#!/usr/bin/env bun

import { runCliMain } from "../src/_cli-main.ts";
import { buildProgram } from "../src/model-gateway/cli.ts";

await runCliMain(() => buildProgram("dbx-model-gateway").parseAsync(process.argv));
