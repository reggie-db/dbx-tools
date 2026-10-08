#!/usr/bin/env bun

import { buildProgram } from "../src/model-gateway/cli.ts";

await buildProgram("dbx-model-gateway").parseAsync(process.argv);
