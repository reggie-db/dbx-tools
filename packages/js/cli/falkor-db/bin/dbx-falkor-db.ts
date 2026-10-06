#!/usr/bin/env bun

import { buildProgram } from "../src/cli.ts";

await buildProgram("dbx-falkor-db").parseAsync(process.argv);
