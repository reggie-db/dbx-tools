#!/usr/bin/env bun

import { configUtils } from "@dbx-tools/core";
import { runCliMain } from "../src/_cli-main.ts";
import { buildProgram } from "../src/genie-code/cli.ts";
import { RUNNER_OPTIONS_KEY, runGenieCodeChild } from "../src/genie-code/runner.ts";

await runCliMain(async () => {
  if (configUtils.resolveValue(RUNNER_OPTIONS_KEY, { sources: "env" })) {
    await runGenieCodeChild();
  } else {
    await buildProgram("dbx-genie").parseAsync(process.argv);
  }
});
