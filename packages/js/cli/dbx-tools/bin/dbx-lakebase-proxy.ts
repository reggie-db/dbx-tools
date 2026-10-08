#!/usr/bin/env node
import { buildProgram } from "../src/lakebase-proxy/cli.ts";

await buildProgram("dbx-lakebase-proxy").parseAsync(process.argv);
