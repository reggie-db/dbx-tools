#!/usr/bin/env node
import { buildProgram } from "../src/cli.ts";

await buildProgram("dbx-lakebase-proxy").parseAsync(process.argv);
