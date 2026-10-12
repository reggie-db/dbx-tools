#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { finished } from "node:stream/promises";
import { appkit } from "@dbx-tools/appkit";
import { devWatch } from "@dbx-tools/projen";
import { parseWatchGlobOptions, serializedWatchGlobArgs } from "../projen/tasks/dev-watch.ts";
import { log } from "@dbx-tools/shared-core";
import { parse } from "yaml";

const logger = log.logger("demo");
const ROOT = process.cwd();
const DEMO_BUNDLE = path.join(ROOT, "packages/example/server/appkit-demo/databricks.yml");
const DEMO_SERVER = path.join(path.dirname(DEMO_BUNDLE), "src/server.ts");
const DEMO_CLIENT = "@dbx-tools/demo-appkit-app";
const DEMO_CLIENT_PORT = 5173;
const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

let resolvedDemoEnv: Promise<NodeJS.ProcessEnv> | undefined;

/** Resolve Lakebase once, then return the environment shared by every demo process. */
function demoEnv(): Promise<NodeJS.ProcessEnv> {
  resolvedDemoEnv ??= (async () => {
    delete process.env.FORCE_COLOR;
    process.env.LAKEBASE_ENDPOINT ??= await demoLakebaseEndpoint();
    process.env.CLIENT_DIST = path.join(ROOT, "packages/example/app/appkit-demo/dist");
    process.env.CLIENT_DEV_URL ??= `http://127.0.0.1:${DEMO_CLIENT_PORT}`;
    process.env.PYTHON = path.join(ROOT, ".venv/bin/python");
    await appkit.autoConfigure({ autoConfigure: "env" });
    return {
      ...process.env,
      BUN_CONFIG_ELIDE_LINES: "0",
      NODE_ENV: "development",
    };
  })();
  return resolvedDemoEnv;
}

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

/** Create a terminal stream with a matching ANSI-free file stream. */
async function createLoggedOutput(): Promise<{
  output: PassThrough;
  close: () => Promise<void>;
}> {
  const logsDir = path.join(ROOT, ".logs");
  await mkdir(logsDir, { recursive: true });
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const logFile = path.join(logsDir, `demo-${timestamp}-${randomUUID()}.log`);
  const output = new PassThrough();
  const plainText = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk.toString().replace(ANSI_SEQUENCE, ""));
    },
  });
  const file = createWriteStream(logFile);
  output.pipe(process.stdout, { end: false });
  output.pipe(plainText).pipe(file);
  logger.info("logging", { file: path.relative(ROOT, logFile) });
  return {
    output,
    close: async () => {
      output.end();
      await finished(file);
    },
  };
}

/** Root task command that watches the concrete demo server entrypoint. */
export function demoServerCommand(argv: readonly string[] = process.argv.slice(2)): string {
  let command = `bun --env-file=.env --env-file=.env.local run --elide-lines=0 ${devWatch.DEV_WATCH_TASK}`;
  const watchArgs = serializedWatchGlobArgs(parseWatchGlobOptions(argv));
  if (watchArgs.length > 0) {
    command += ` ${watchArgs.map((part) => JSON.stringify(part)).join(" ")}`;
  }
  return `${command} bun ${JSON.stringify(path.relative(ROOT, DEMO_SERVER))}`;
}

/** Root task command for Bun's React HMR development server. */
export function demoClientCommand(): string {
  return `bun --env-file=.env --env-file=.env.local run --elide-lines=0 --filter ${DEMO_CLIENT} dev`;
}

/** Run the Bun client HMR server and AppKit backend together. */
async function runDemo(): Promise<void> {
  delete process.env.FORCE_COLOR;
  const { default: concurrently } = await import("concurrently");
  const { output, close } = await createLoggedOutput();
  const env = await demoEnv();
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? Boolean(stdin.isRaw) : false;
  const { result } = concurrently(
    [
      {
        command: demoClientCommand(),
        name: "client",
        prefixColor: "magenta",
        env: {
          ...process.env,
          PORT: String(DEMO_CLIENT_PORT),
        },
      },
      {
        command: demoServerCommand(),
        name: "server",
        prefixColor: "cyan",
        env,
      },
    ],
    {
      cwd: ROOT,
      killOthersOn: ["success", "failure"],
      defaultInputTarget: "server",
      handleInput: stdin.isTTY,
      outputStream: output,
      prefix: "name",
    },
  );
  const onInterrupt = (chunk: Buffer | string): void => {
    if (!String(chunk).includes("\u0003")) return;
    process.emit("SIGINT", "SIGINT");
  };
  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.on("data", onInterrupt);
  }
  try {
    await result;
  } finally {
    stdin.off("data", onInterrupt);
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    await close();
  }
}

if (import.meta.main) {
  try {
    await runDemo();
  } catch (err) {
    logger.error("failed", err);
    process.exitCode = 1;
  }
}
