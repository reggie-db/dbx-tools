/** Parse and print generated PyPI trusted-publisher setup instructions. */
import { z } from "zod";
import { taskCommand, taskOptions } from "./cli.ts";

export const PypiTrustedPublisherInstructionsOptionsSchema = z
  .object({
    secretFile: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Credential file used only when browser authentication is required")
      .meta({ env: [], helpDefault: false, short: false }),
  })
  .describe("Options for rendering PyPI trusted-publisher setup instructions");

/** Project-specific instruction sections wrapped around browser authentication guidance. */
export interface PypiTrustedPublisherInstructions {
  readonly afterAuthentication: readonly string[];
  readonly beforeAuthentication: readonly string[];
}

/** Parse task options and write the complete trusted-publisher instructions. */
export async function printPypiTrustedPublisherInstructions(
  instructions: PypiTrustedPublisherInstructions,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const { secretFile } = await taskOptions(
    taskCommand(
      import.meta.url,
      "Print system-browser instructions for PyPI trusted publishers",
      PypiTrustedPublisherInstructionsOptionsSchema,
    ),
    PypiTrustedPublisherInstructionsOptionsSchema,
    argv,
  );
  const authentication = secretFile
    ? [
        `- If browser authentication is required, read credentials from ${secretFile} directly into the browser without printing, logging, or exposing secret values.`,
        `- If ${secretFile} is absent, invalid, or insufficient for authentication, pause and ask the user to complete authentication.`,
      ]
    : [
        "- If browser authentication is required, pause and ask the user to complete authentication.",
      ];
  process.stdout.write(
    `${[
      ...instructions.beforeAuthentication,
      ...authentication,
      ...instructions.afterAuthentication,
    ]
      .join("\n")
      .trimEnd()}\n`,
  );
}
