#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { PassThrough, Transform } from "node:stream";
import { log } from "@dbx-tools/shared-core";

const logger = log.logger("demo");
const ROOT = process.cwd();
const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** Environment shared by every demo process. */
function demoEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BUN_CONFIG_ELIDE_LINES: "0",
    FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
    NODE_ENV: "development",
  };
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
      env: demoEnv(),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
}

/** Start only the Python bus emitter for the `demo:emitter` task. */
async function runEmitter(): Promise<void> {
  await run(["uv", "run", "python", "packages/example/python/bus-emitter.py"], {
    cwd: ROOT,
    env: demoEnv(),
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

/** Build and run the server, client, and emitter as one supervised process group. */
async function runDemo(): Promise<void> {
  await buildClient();
  process.env.FORCE_COLOR ??= "1";
  const { default: concurrently } = await import("concurrently");
  const { output, close } = await createLoggedOutput();
  const env = demoEnv();
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
        command: `${bun} --filter @dbx-tools/demo-appkit-app dev`,
        name: "client",
        prefixColor: "magenta",
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
