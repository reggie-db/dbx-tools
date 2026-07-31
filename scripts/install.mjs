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

const NPMJS_REGISTRY = "https://registry.npmjs.org";

/**
 * A non-default registry to force onto npm and pnpm, or null when the effective
 * one is already public npmjs.
 *
 * Both channels are consulted because they disagree: `npm config get registry`
 * sees `.npmrc` files, while a container may only export `npm_config_registry`.
 * This is a standalone installer that runs before any `@dbx-tools` package is
 * available, so it cannot reuse `@dbx-tools/core`'s resolver.
 */
function registryOverride() {
  const candidates = [
    spawnSync("npm", ["config", "get", "registry"], {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    }).stdout,
    process.env.npm_config_registry,
    process.env.NPM_CONFIG_REGISTRY,
  ];

  for (const candidate of candidates) {
    const url = candidate?.trim();
    if (!url || url === "undefined" || !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) continue;
    if (url === NPMJS_REGISTRY || url.startsWith(`${NPMJS_REGISTRY}/`)) continue;
    return url;
  }
  return null;
}

const registry = registryOverride();

/**
 * `--registry <url>` when an override is in play, else nothing.
 *
 * pnpm ignores `npm_config_registry` from the environment (npm honors it), so a
 * flag is the only channel that reaches both. Callers place it where the tool
 * expects: for npm/npx, before the package name.
 */
function registryArgs() {
  return registry ? ["--registry", registry] : [];
}

/** Run a setup command and fail on a nonzero exit. */
function run(command, args, cwd = process.cwd()) {
  log(`running ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env: registry
      ? { ...process.env, npm_config_registry: registry, NPM_CONFIG_REGISTRY: registry }
      : process.env,
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
  run("npm", ["install", "--global", ...registryArgs(), ...globalPackages]);
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
  // `install` resolves packages so it takes the flag; `exec` forwards trailing
  // arguments to projen, so it must not.
  run("pnpm", ["install", "--no-frozen-lockfile", "--force", ...registryArgs()], root);
  run("pnpm", ["exec", "projen"], root);
  log("dbx-tools development environment is ready");
} else {
  log("dbx-tools command environment is ready");
}
