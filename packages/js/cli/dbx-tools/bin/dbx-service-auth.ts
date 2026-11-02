#!/usr/bin/env bun

import { runDatabricksServiceAuthCli } from "../src/service-auth.ts";

await runDatabricksServiceAuthCli(process.argv.slice(2));
