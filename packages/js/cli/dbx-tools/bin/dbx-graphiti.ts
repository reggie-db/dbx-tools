#!/usr/bin/env bun

import { buildProgram } from "../src/graphiti/cli.ts";

await buildProgram("dbx-graphiti").parseAsync(process.argv);
