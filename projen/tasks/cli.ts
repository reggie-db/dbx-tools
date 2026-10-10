/** Shared Commander and entrypoint integration for Projen task CLIs. */
import { basename, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { addArgs, parseArgs, type CliArgsOptions } from "@dbx-tools/cli-args";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { stringUtils } from "@dbx-tools/shared-core";
import { Command } from "commander";
import { z } from "zod";

/** Stable task name derived from its source filename. */
export function taskName(moduleUrl: string): string {
  const file = basename(fileURLToPath(moduleUrl));
  return file.slice(0, -extname(file).length);
}

/** Config resolution shared by task schemas. */
export function taskCliArgsOptions(moduleUrl: string): CliArgsOptions {
  const prefix = [...stringUtils.tokenize(taskName(moduleUrl))].join("_").toUpperCase();
  return {
    cwd: process.cwd(),
    prefix: `PROJEN_${prefix}`,
    sources: ["env", "dotenv"],
  };
}

/** Create a task command and bind every Zod-owned option through cli-args. */
export function taskCommand<T extends z.ZodRawShape>(
  moduleUrl: string,
  description: string,
  schema: z.ZodObject<T>,
): Command {
  return addArgs(
    new Command().name(taskName(moduleUrl)).description(description),
    schema,
    taskCliArgsOptions(moduleUrl),
  );
}

/** Parse one task's flags and layered environment values through its schema. */
export async function taskOptions<T extends z.ZodRawShape>(
  command: Command,
  schema: z.ZodObject<T>,
  argv: readonly string[] = process.argv.slice(2),
): Promise<z.output<z.ZodObject<T>>> {
  await command.parseAsync([...argv], { from: "user" });
  return parseArgs(command, schema);
}

/** Read one already-parsed task command through its owning Zod schema. */
export function parsedTaskOptions<T extends z.ZodRawShape>(
  command: Command,
  schema: z.ZodObject<T>,
): z.output<z.ZodObject<T>> {
  return parseArgs(command, schema);
}

/** Read positional arguments after Commander has parsed one task command. */
export function taskPositionals(command: Command): readonly unknown[] {
  return command.processedArgs;
}

/** Resolve the explicit task root or discover the current project root. */
export function taskRoot(root?: string): string {
  return resolve(root ?? projectUtils.root() ?? process.cwd());
}

/** True when an imported task module is the active Bun or Node entrypoint. */
export function isTaskMain(meta: ImportMeta): boolean {
  if (meta.main) return true;
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(resolve(entry)).href === meta.url);
}

/** Run a task only when its module is the active process entrypoint. */
export async function runTaskMain(
  meta: ImportMeta,
  main: () => void | Promise<void>,
): Promise<void> {
  if (isTaskMain(meta)) await main();
}
