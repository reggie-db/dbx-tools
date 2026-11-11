/** Shared Commander and entrypoint integration for Projen task CLIs. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { addModuleArgs, parseArgs, parseModuleArgv } from "@dbx-tools/cli-args";
import { projectUtils } from "@dbx-tools/core";
import { Command } from "commander";
import { z } from "zod";

const TASK_ARGS_OPTIONS = {
  environmentPrefix: "PROJEN",
  sources: ["env", "dotenv"],
} as const;

/** Create a task command and bind every Zod-owned option through cli-args. */
export function taskCommand<T extends z.ZodRawShape>(
  moduleUrl: string,
  description: string,
  schema: z.ZodObject<T>,
): Command {
  return addModuleArgs(moduleUrl, schema, TASK_ARGS_OPTIONS).description(description);
}

/** Parse one Projen task module through its owning Zod schema. */
export function parseTaskArgv<T extends z.ZodRawShape>(
  meta: ImportMeta,
  schema: z.ZodObject<T>,
  argv: readonly string[] = process.argv.slice(2),
): z.output<z.ZodObject<T>> {
  return parseModuleArgv(meta.url, schema, argv, TASK_ARGS_OPTIONS);
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

/** Run an existing task main only when its module is the active process entrypoint. */
export function runTaskMain(meta: ImportMeta, main: () => void | Promise<void>): Promise<void>;

/** Build a schema-driven task main and run it when its module is the active entrypoint. */
export function runTaskMain<T extends z.ZodRawShape>(
  meta: ImportMeta,
  schema: z.ZodObject<T>,
  handler: (options: z.output<z.ZodObject<T>>) => void | Promise<void>,
): Promise<(argv?: readonly string[]) => Promise<void>>;

export async function runTaskMain<T extends z.ZodRawShape>(
  meta: ImportMeta,
  mainOrSchema: (() => void | Promise<void>) | z.ZodObject<T>,
  handler?: (options: z.output<z.ZodObject<T>>) => void | Promise<void>,
): Promise<void | ((argv?: readonly string[]) => Promise<void>)> {
  if (typeof mainOrSchema === "function") {
    if (isTaskMain(meta)) await mainOrSchema();
    return;
  }
  if (!handler) throw new TypeError("Schema-driven task main requires a handler");
  const main = async (argv: readonly string[] = process.argv.slice(2)): Promise<void> => {
    await handler(parseTaskArgv(meta, mainOrSchema, argv));
  };
  if (isTaskMain(meta)) await main();
  return main;
}
