#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { PassThrough, Transform } from "node:stream";
import { appkit } from "@dbx-tools/appkit";
import { log } from "@dbx-tools/shared-core";
import { parse } from "yaml";

const logger = log.logger("demo");
const ROOT = process.cwd();
const DEMO_BUNDLE = path.join(ROOT, "packages/example/server/appkit-demo/databricks.yml");
const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

let resolvedDemoEnv: Promise<NodeJS.ProcessEnv> | undefined;

/** Resolve Lakebase once, then return the environment shared by every demo process. */
function demoEnv(): Promise<NodeJS.ProcessEnv> {
  resolvedDemoEnv ??= (async () => {
    delete process.env.FORCE_COLOR;
    process.env.LAKEBASE_ENDPOINT ??= await demoLakebaseEndpoint();
    process.env.CLIENT_DIST = path.join(ROOT, "packages/example/app/appkit-demo/dist");
    process.env.PYTHON = path.join(ROOT, ".venv/bin/python");
    process.env.PORTR_TOKEN = "";
    process.env.TUNNEL_PUBLIC_DOMAIN = "";
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

/** Return non-Lakebase build environment while the client compiles. */
function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BUN_CONFIG_ELIDE_LINES: "0",
    NODE_ENV: "development",
  };
  delete env.FORCE_COLOR;
  return env;
}

/** Run a finite command and fail when it exits unsuccessfully. */
async function run(
  command: string[],
  options: Bun.SpawnOptions.OptionsObject<"inherit", "inherit", "inherit">,
): Promise<void> {
  const child = Bun.spawn(command, options);
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command[0]} exited with code ${exitCode}`);
  }
}

/** Build the static client served by AppKit on the API port. */
async function buildClient(): Promise<void> {
  await run(
    [
      process.execPath,
      "--env-file=.env",
      "--env-file=.env.local",
      "run",
      "--elide-lines=0",
      "--filter",
      "@dbx-tools/demo-appkit-app",
      "compile",
    ],
    {
      cwd: ROOT,
      env: buildEnv(),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
}

/** Start only the Python bus emitter for the `demo:emitter` task. */
async function runEmitter(): Promise<void> {
  const env = await demoEnv();
  await run(["uv", "run", "python", "packages/example/python/bus-emitter.py"], {
    cwd: ROOT,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
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

/** Build the client, then run the Caddy-fronted server and emitter together. */
async function runDemo(): Promise<void> {
  delete process.env.FORCE_COLOR;
  await buildClient();
  const { default: concurrently } = await import("concurrently");
  const { output, close } = await createLoggedOutput();
  const env = await demoEnv();
  const bun = "bun --env-file=.env --env-file=.env.local run --elide-lines=0";
  const { result } = concurrently(
    [
      {
        command: `${bun} --filter @dbx-tools/demo-appkit-server dev`,
        name: "server",
        prefixColor: "cyan",
        env,
      },
      {
        command: "uv run python packages/example/python/bus-emitter.py",
        name: "emitter",
        prefixColor: "green",
        env,
      },
    ],
    {
      cwd: ROOT,
      killOthersOn: ["success", "failure"],
      outputStream: output,
      prefix: "name",
    },
  );
  try {
    await result;
  } finally {
    await close();
  }
}

try {
  if (process.argv.includes("--emitter-only")) {
    await runEmitter();
  } else {
    await runDemo();
  }
} catch (err) {
  logger.error("failed", err);
  process.exitCode = 1;
}
