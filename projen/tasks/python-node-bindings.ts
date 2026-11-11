#!/usr/bin/env -S bun
/** CLI entrypoint for PythonMonkey Node binding generation. */
import { z } from "zod";
import { runTaskMain } from "./cli.ts";
import { runPythonNodeBindings } from "../src/_python-node-bindings-generator.ts";

export const PythonNodeBindingsOptionsSchema = z
  .object({
    binding: z.coerce
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Configured binding index within the selected project"),
    check: z.boolean().default(false).describe("Check generated state without writing changes"),
    force: z
      .boolean()
      .default(false)
      .describe("Force regeneration even when outputs appear current"),
    module: z.string().trim().min(1).optional().describe("Configured package module to generate"),
    project: z.string().trim().min(1).optional().describe("Python project directory"),
    root: z.string().trim().min(1).optional().describe("Repository or workspace root"),
  })
  .describe("Generate PythonMonkey runtime and typed Python wrappers");

export const main = await runTaskMain(
  import.meta,
  PythonNodeBindingsOptionsSchema,
  runPythonNodeBindings,
);
