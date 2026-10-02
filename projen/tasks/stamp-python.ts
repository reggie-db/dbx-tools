#!/usr/bin/env -S bun
import { Command } from "commander";
import { stampPythonProjects } from "./publish-python.ts";

const program = new Command();
program
  .argument("<version>", "Python package version")
  .option("--root <path>", "Python workspace package root", "packages/py")
  .action((version: string, options: { root: string }) => {
    stampPythonProjects(options.root, version);
  });

await program.parseAsync();
