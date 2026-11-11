#!/usr/bin/env -S bun
/** Build or publish selected Python workspace distributions. */
import { z } from "zod";
import { runTaskMain, taskCommand, taskOptions, taskPositionals } from "./cli.ts";
import { buildPythonProjects, publishPythonProjects } from "../src/python-packaging.ts";

/** Parse command-line publication options and run the Python release task. */
export const PublishPythonOptionsSchema = z.object({
  indexUrl: z.string().trim().min(1).optional().describe("devpi Simple API URL"),
  publishUrl: z.string().trim().min(1).optional().describe("devpi writable index URL"),
  root: z.string().trim().min(1).default("packages/py").describe("Python workspace package root"),
  package: z
    .array(z.string().trim().min(1))
    .default([])
    .describe("Repeatable Python package directory to build"),
  output: z.string().trim().min(1).optional().describe("Build distributions into this directory"),
  packageDirectories: z
    .boolean()
    .default(false)
    .describe("Keep each package's distributions in its own output directory"),
  dryRun: z.boolean().default(false).describe("Validate artifacts without publishing them"),
});

/** Parse task options and build or publish Python workspace distributions. */
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const command = taskCommand(
    import.meta.url,
    "Build or publish Python workspace distributions",
    PublishPythonOptionsSchema,
  ).argument("<version>", "Python package version");
  const options = await taskOptions(command, PublishPythonOptionsSchema, args);
  const version = String(taskPositionals(command)[0]);
  if (options.output) {
    buildPythonProjects({
      output: options.output,
      packages: options.package.length ? options.package : undefined,
      packageDirectories: options.packageDirectories,
      root: options.root,
      version,
    });
    return;
  }
  if (!options.indexUrl || !options.publishUrl) {
    throw new Error("--index-url and --publish-url are required when publishing");
  }
  publishPythonProjects({
    dryRun: options.dryRun,
    indexUrl: options.indexUrl,
    publishUrl: options.publishUrl,
    root: options.root,
    version,
  });
}

await runTaskMain(import.meta, main);
