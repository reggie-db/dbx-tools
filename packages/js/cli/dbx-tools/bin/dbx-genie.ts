#!/usr/bin/env bun

import { buildProgram } from "../src/genie-code/cli.ts";
import {
  RUNNER_OPTIONS_ENV,
  runGenieCodeChild,
} from "../src/genie-code/runner.ts";

if (process.env[RUNNER_OPTIONS_ENV]) {
  await runGenieCodeChild();
} else {
  await buildProgram("dbx-genie").parseAsync(process.argv);
}
