#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import path from "node:path";
import { autoConfigure } from "@dbx-tools/appkit";
import { log } from "@dbx-tools/shared-core";
import { parse } from "yaml";
import { main as runDevWatch } from "../projen/tasks/dev-watch.ts";

const logger = log.logger("demo");
const ROOT = process.cwd();
const DEMO_DIR = path.join(ROOT, "packages/demo");
const DEMO_BUNDLE = path.join(DEMO_DIR, "databricks.yml");
const DEMO_SERVER = path.join(path.dirname(DEMO_BUNDLE), "server/server.ts");

/** Resolve the demo endpoint from its bundle variable defaults. */
async function demoLakebaseEndpoint(): Promise<string> {
  const bundle = parse(await readFile(DEMO_BUNDLE, "utf8")) as {
    variables?: Record<string, { default?: unknown }>;
  };
  const variables = bundle.variables ?? {};
  const endpoint = variables.lakebase_endpoint?.default;
  if (typeof endpoint !== "string" || !endpoint) {
    throw new Error("demo bundle has no default lakebase_endpoint");
  }
  return endpoint.replace(/\$\{var\.([^}]+)\}/g, (_match, name: string) => {
    const value = variables[name]?.default;
    if (typeof value !== "string" || !value) {
      throw new Error(`demo bundle variable ${name} has no string default`);
    }
    return value;
  });
}

/** Watcher argv for the demo server, including user-supplied watcher flags. */
export function demoWatchArgs(argv: readonly string[] = process.argv.slice(2)): string[] {
  return [
    ...argv,
    "bun",
    "--cwd",
    path.relative(ROOT, DEMO_DIR),
    path.relative(DEMO_DIR, DEMO_SERVER),
  ];
}

/** Run the AppKit backend. Vite middleware HMR shares this process and port. */
async function runDemo(): Promise<void> {
  process.env.LAKEBASE_ENDPOINT ??= await demoLakebaseEndpoint();
  process.env.PYTHON = path.join(ROOT, ".venv/bin/python");
  await autoConfigure({ autoConfigure: "env" });
  await runDevWatch(demoWatchArgs());
}

if (import.meta.main) {
  try {
    await runDemo();
  } catch (err) {
    logger.error("failed", err);
    process.exitCode = 1;
  }
}
