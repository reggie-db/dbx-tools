/** Shared process boundary for the public dbx-tools CLI binaries. */
import { activeLevel, errorMessage, toError } from "@dbx-tools/shared-core";
import cleanStack from "clean-stack";
import { z } from "zod";

type CliTask = () => Promise<unknown> | unknown;
type CliErrorWriter = (message: string) => void;
type CliExitCodeWriter = (code: number) => void;

function conciseCliError(error: unknown): string {
  if (!(error instanceof z.ZodError)) return `Error: ${errorMessage(error)}`;
  const issues = error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return `${path ? `${path}: ` : ""}${issue.message}`;
  });
  if (issues.length === 1) return `Error: ${issues[0]}`;
  return `Error:\n${issues.map((issue) => `- ${issue}`).join("\n")}`;
}

/** Format an uncaught CLI failure for stderr. */
export function formatCliError(error: unknown, detailed = activeLevel() === "debug"): string {
  if (!detailed) return conciseCliError(error);
  const normalized = toError(error);
  return normalized.stack
    ? cleanStack(normalized.stack, { pretty: true })
    : `${normalized.name}: ${normalized.message}`;
}

/** Run a CLI task with concise default errors and debug stack traces. */
export async function runCliMain(
  task: CliTask,
  writeError: CliErrorWriter = (message) => process.stderr.write(`${message}\n`),
  writeExitCode: CliExitCodeWriter = (code) => {
    process.exitCode = code;
  },
): Promise<void> {
  try {
    await task();
  } catch (error) {
    writeError(formatCliError(error));
    writeExitCode(1);
  }
}
