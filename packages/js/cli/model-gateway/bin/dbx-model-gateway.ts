#!/usr/bin/env bun

import { buildProgram } from "../src/cli.ts";

await buildProgram("dbx-model-gateway").parseAsync(process.argv);
