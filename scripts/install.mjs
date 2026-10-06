#!/usr/bin/env bun

/**
 * Install the dbx-tools CLI with Bun and optionally prepare a local checkout.
 *
 * `install.sh` owns bootstrapping Bun on machines that do not have it. Once Bun
 * is available, this script keeps package installation and synthesis on the
 * repository's supported toolchain and configured registry.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PACKAGE = "@dbx-tools/cli";
const DEV_INSTALL = process.env.DEV_INSTALL === "1";

/** Write an installer progress message without using stdout. */
function log(message) {
  process.stderr.write(`[dbx-tools] ${message}\n`);
}

/** Return whether a command completes successfully without forwarding output. */
function succeeds(command, args) {
  return (
    spawnSync(command, args, {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }).status === 0
  );
}

/** Run a setup command and fail on a nonzero exit. */
function run(command, args, cwd = process.cwd()) {
  log(`running ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: ["inherit", 2, 2],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

/** Resolve the repository root when local development mode is enabled. */
function resolveDevRoot() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  if (!existsSync(join(root, "package.json"))) {
    throw new Error("DEV_INSTALL=1 requires install.mjs inside a checkout");
  }
  return root;
}

if (!succeeds("dbx", ["--help"]) || !succeeds("dbx-tools", ["--help"])) {
  run("bun", ["add", "--global", CLI_PACKAGE]);
}
if (!succeeds("dbx", ["--help"]) || !succeeds("dbx-tools", ["--help"])) {
  throw new Error(`${CLI_PACKAGE} installed without usable dbx and dbx-tools commands`);
}

log("dbx and dbx-tools commands are ready");
if (DEV_INSTALL) {
  const root = resolveDevRoot();
  run("bun", ["install", "--force"], root);
  run("bunx", ["projen"], root);
  log("dbx-tools development environment is ready");
} else {
  log("dbx-tools command environment is ready");
}
