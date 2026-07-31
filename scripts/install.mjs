#!/usr/bin/env node

/**
 * Completes dbx-tools setup after install.sh provides Node.js and npm.
 *
 * The default remote mode installs pnpm without requiring a repository clone.
 * DEV_INSTALL=1 runs from a local checkout and also installs and synthesizes
 * that workspace.
 *
 * All output is written to stderr so install.sh can reserve stdout for shell
 * exports when it is invoked through eval.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PNPM_VERSION = "10.33.0";
const CLI_PACKAGE = "@dbx-tools/cli";
const DEV_INSTALL = process.env.DEV_INSTALL === "1";

/** Write an installer progress message without using stdout. */
function log(message) {
  process.stderr.write(`[dbx-tools] ${message}\n`);
}

/** Read a command's version without forwarding its output. */
function version(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return result.status === 0 ? result.stdout.trim() : null;
}

/** Return whether a command completes successfully without forwarding output. */
function succeeds(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return result.status === 0;
}

/** Run a setup command and fail on a nonzero exit. */
function run(command, args, cwd = process.cwd()) {
  log(`running ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: ["inherit", 2, 2],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

/** Resolve the repository root when the local development mode is enabled. */
function resolveDevRoot() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  if (!existsSync(join(root, "package.json"))) {
    throw new Error("DEV_INSTALL=1 requires install.mjs inside a checkout");
  }
  return root;
}

/** Read the workspace's exact pnpm version from packageManager. */
function workspacePnpmVersion(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const packageManager = manifest.packageManager;
  const match = typeof packageManager === "string" ? /^pnpm@(.+)$/.exec(packageManager) : null;

  if (!match) {
    throw new Error("package.json must declare packageManager as pnpm@<version>");
  }
  return match[1];
}

const root = DEV_INSTALL ? resolveDevRoot() : null;
const pnpmVersion =
  process.env.PNPM_VERSION ?? (root ? workspacePnpmVersion(root) : DEFAULT_PNPM_VERSION);
const globalPackages = [];

if (version("pnpm") !== pnpmVersion) {
  globalPackages.push(`pnpm@${pnpmVersion}`);
}
if (!succeeds("dbxt", ["--help"]) || !succeeds("dbx-tools", ["--help"])) {
  globalPackages.push(CLI_PACKAGE);
}
if (globalPackages.length > 0) {
  run("npm", ["install", "--global", ...globalPackages]);
  run("mise", ["reshim"]);
}

const installedPnpmVersion = version("pnpm");
if (installedPnpmVersion !== pnpmVersion) {
  throw new Error(`expected pnpm ${pnpmVersion}, found ${installedPnpmVersion ?? "none"}`);
}
if (!succeeds("dbxt", ["--help"]) || !succeeds("dbx-tools", ["--help"])) {
  throw new Error(`${CLI_PACKAGE} installed without usable dbxt and dbx-tools commands`);
}

log(`using pnpm ${installedPnpmVersion}`);
log("dbxt and dbx-tools commands are ready");
if (root) {
  run("pnpm", ["install", "--no-frozen-lockfile", "--force"], root);
  run("pnpm", ["exec", "projen"], root);
  log("dbx-tools development environment is ready");
} else {
  log("dbx-tools command environment is ready");
}
