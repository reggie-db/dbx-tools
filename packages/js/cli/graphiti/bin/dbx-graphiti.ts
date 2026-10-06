#!/usr/bin/env bun

import { buildProgram } from "../src/cli.ts";

await buildProgram("dbx-graphiti").parseAsync(process.argv);
