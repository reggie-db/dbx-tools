#!/usr/bin/env -S bun
/** Export the current annotated release tag's step selection to GitHub Actions. */
import { appendFileSync } from "node:fs";
import { z } from "zod";
import { runTaskMain, taskCommand, taskOptions } from "./cli.ts";
import { captureTaskCommand } from "../src/_task-command.ts";
import { parseReleaseTagAnnotation } from "../src/release-options.ts";

export const ReleaseOptionsTaskSchema = z.object({
  tag: z.string().trim().min(1).describe("Annotated release tag"),
  output: z.string().trim().min(1).describe("GitHub Actions output file"),
});

/** Verify and export a tag policy using the shared annotated-tag contract. */
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const values = await taskOptions(
    taskCommand(
      import.meta.url,
      "Export release tag selections to GitHub Actions",
      ReleaseOptionsTaskSchema,
    ),
    ReleaseOptionsTaskSchema,
    args,
  );
  const annotation = captureTaskCommand(
    process.cwd(),
    "git",
    ["for-each-ref", "--format=%(contents)", `refs/tags/${values.tag}`],
    { check: true },
  );
  if (!annotation) throw new Error(`Release tag ${values.tag} has no annotation`);
  const selection = parseReleaseTagAnnotation(annotation);
  appendFileSync(
    values.output,
    Object.entries(selection)
      .map(([name, enabled]) => `${name}=${enabled}\n`)
      .join(""),
  );
}

await runTaskMain(import.meta, main);
