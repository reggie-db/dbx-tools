#!/usr/bin/env -S bun
/** Export the current annotated release tag's step selection to GitHub Actions. */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { captureTaskCommand } from "../src/_task-command.ts";
import { parseReleaseTagAnnotation } from "../src/release-options.ts";

/** Verify and export a tag policy using the shared annotated-tag contract. */
export function main(args: string[] = process.argv.slice(2)): void {
  const { values } = parseArgs({
    args,
    options: { tag: { type: "string" }, output: { type: "string" } },
    strict: true,
  });
  if (!values.tag || !values.output) throw new Error("--tag and --output are required");
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

if (import.meta.main) main();
