/**
 * `dbx brand` researched brand-package export.
 *
 * @module
 */

import { addArgs, parseArgs } from "@dbx-tools/cli-args";
import { Command } from "commander";

import { BrandExportOptionsSchema } from "./options.ts";
import { exportBrandFromPrompt } from "./run.ts";

/** Replaceable command boundaries used by tests and embedders. */
export interface BrandCliDependencies {
  readonly exportBrandFromPrompt?: typeof exportBrandFromPrompt;
  readonly writeProgress?: (value: string) => void;
  readonly writeResult?: (value: unknown) => void;
}

/** Build the lazily loaded `dbx brand` command. */
export function buildProgram(name = "dbx brand", dependencies: BrandCliDependencies = {}): Command {
  const runExport = dependencies.exportBrandFromPrompt ?? exportBrandFromPrompt;
  const writeProgress =
    dependencies.writeProgress ?? ((value: string) => process.stderr.write(`${value}\n`));
  const writeResult =
    dependencies.writeResult ??
    ((value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`));
  const program = addArgs(
    new Command()
      .name(name)
      .description(
        "Research a brand brief and export brand.yaml with web and mobile visual references",
      ),
    BrandExportOptionsSchema,
  );
  program
    .argument("<prompt>", "brand, company, product, or design brief to research")
    .action(async (prompt: string) => {
      const options = parseArgs(program, BrandExportOptionsSchema);
      const result = await runExport(prompt, options, {
        onProgress(event) {
          writeProgress(`[${event.stage}] ${event.message}`);
        },
      });
      writeResult({
        brand: result.brandYamlPath,
        manifest: result.manifestPath,
        references: result.referenceCount,
      });
    });
  return program;
}
