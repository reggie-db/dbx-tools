#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import path from "node:path";
import { appkit } from "@dbx-tools/appkit";
import * as exec from "@dbx-tools/core/exec";
import { devWatch } from "@dbx-tools/projen";
import { log } from "@dbx-tools/shared-core";
import { parse } from "yaml";
import { parseWatchGlobOptions, serializedWatchGlobArgs } from "../projen/tasks/dev-watch.ts";

const logger = log.logger("demo");
const ROOT = process.cwd();
const DEMO_BUNDLE = path.join(ROOT, "packages/example/server/appkit-demo/databricks.yml");
const DEMO_SERVER = path.join(path.dirname(DEMO_BUNDLE), "src/server.ts");

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

/** Argv that runs the demo server under `dev:watch`, forwarding watcher flags. */
export function demoServerCommand(argv: readonly string[] = process.argv.slice(2)): string[] {
  return [
    "bun",
    "--env-file=.env",
    "--env-file=.env.local",
    "run",
    "--elide-lines=0",
    devWatch.DEV_WATCH_TASK,
    ...serializedWatchGlobArgs(parseWatchGlobOptions(argv)),
    "bun",
    path.relative(ROOT, DEMO_SERVER),
  ];
}

/** Run the AppKit backend. Vite middleware HMR shares this process and port. */
async function runDemo(): Promise<void> {
  process.env.LAKEBASE_ENDPOINT ??= await demoLakebaseEndpoint();
  process.env.PYTHON = path.join(ROOT, ".venv/bin/python");
  await appkit.autoConfigure({ autoConfigure: "env" });
  const [command, ...args] = demoServerCommand();
  const { exitCode } = await exec.spawn(command!, args, {
    cwd: ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    check: false,
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

if (import.meta.main) {
  try {
    await runDemo();
  } catch (err) {
    logger.error("failed", err);
    process.exitCode = 1;
  }
}
