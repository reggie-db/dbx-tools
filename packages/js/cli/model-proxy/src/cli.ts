/**
 * `dbx model-proxy` execution and per-user service lifecycle.
 *
 * The command prefers an already installed Python proxy with the exact CLI
 * package version. When it is absent or stale, uv installs the matching
 * `dbx-tools-model-proxy` tool before argv is forwarded unchanged.
 *
 * @module
 */

import { constants, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

import * as exec from "@dbx-tools/core/exec";
import { json } from "@dbx-tools/shared-core";
import { Command } from "commander";

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** @internal Injectable process and environment boundary for CLI tests. */
export interface ModelProxyCliDependencies {
  readonly environment: NodeJS.ProcessEnv;
  findExecutable(name: string): Promise<string | undefined>;
  run(command: string, args: readonly string[], capture: boolean): Promise<RunResult>;
}

const DEFAULT_DEPENDENCIES: ModelProxyCliDependencies = {
  environment: process.env,
  findExecutable,
  async run(command, args, capture) {
    const result = await exec.spawn(command, args, {
      check: false,
      stdin: capture ? "ignore" : "inherit",
      stdout: capture ? "capture" : "inherit",
      stderr: capture ? "capture" : "inherit",
    });
    return result;
  },
};

function argvAfter(argv: readonly string[], prefix: readonly string[]): string[] | undefined {
  for (let index = 0; index <= argv.length - prefix.length; index += 1) {
    if (prefix.every((token, offset) => argv[index + offset] === token)) {
      return argv.slice(index + prefix.length);
    }
  }
  return undefined;
}

/**
 * Commander drops a lone `--` between options and operands. Put it back from
 * `argv` so Python's service installer keeps server flags after the delimiter.
 */
export function restoreInstallArgs(
  args: readonly string[],
  argv: readonly string[] = process.argv,
): string[] {
  const parsed = args.slice(2);
  if (parsed.includes("--")) return [...parsed];
  const raw = argvAfter(argv, ["service", "install"]);
  if (!raw?.includes("--")) return [...parsed];
  const withoutDelimiter = raw.filter((token) => token !== "--");
  if (
    withoutDelimiter.length === parsed.length &&
    withoutDelimiter.every((token, index) => token === parsed[index])
  ) {
    return [...raw];
  }
  return [...parsed];
}

/** Ensure and return the exact-version Python model-proxy executable. */
export async function ensurePythonProxy(
  dependencies: ModelProxyCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const version = packageVersion();
  const configured = dependencies.environment.DBX_TOOLS_MODEL_PROXY_COMMAND?.trim();
  const existing = configured || (await dependencies.findExecutable("dbx-model-proxy"));
  if (existing && (await isExpectedProxy(existing, version, dependencies))) return existing;

  const uv = await dependencies.findExecutable("uv");
  if (!uv) {
    throw new Error(
      "dbx model-proxy requires uv to install dbx-tools-model-proxy when an exact-version Python proxy is not already available",
    );
  }
  const requirement =
    dependencies.environment.DBX_TOOLS_MODEL_PROXY_PACKAGE?.trim() ||
    `dbx-tools-model-proxy==${version}`;
  const installed = await dependencies.run(uv, ["tool", "install", "--force", requirement], false);
  if (installed.exitCode !== 0) {
    throw new Error(`uv could not install ${requirement}`);
  }
  const directory = await dependencies.run(uv, ["tool", "dir", "--bin"], true);
  if (directory.exitCode !== 0 || !directory.stdout.trim()) {
    throw new Error("uv did not return its tool executable directory");
  }
  const executable = join(directory.stdout.trim(), executableName("dbx-model-proxy"));
  if (!(await isExpectedProxy(executable, version, dependencies))) {
    throw new Error(`installed model proxy does not report python-litellm ${version}`);
  }
  return executable;
}

async function run(
  args: readonly string[],
  dependencies: ModelProxyCliDependencies,
): Promise<void> {
  const executable = await ensurePythonProxy(dependencies);
  const forwarded =
    args[0] === "service" && args[1] === "install" ? restoreInstallArgs(args) : [...args];
  const result = await dependencies.run(executable, forwarded, false);
  process.exitCode = result.exitCode;
}

async function isExpectedProxy(
  executable: string,
  version: string,
  dependencies: ModelProxyCliDependencies,
): Promise<boolean> {
  const result = await dependencies.run(executable, ["--runtime-info"], true);
  if (result.exitCode !== 0) return false;
  const info = json.parseRecord(result.stdout);
  return info?.implementation === "python-litellm" && info.version === version;
}

async function findExecutable(name: string): Promise<string | undefined> {
  const path = process.env.PATH;
  if (!path) return undefined;
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function packageVersion(): string {
  for (const location of [
    new URL("../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ]) {
    try {
      const version = json.parseRecord(readFileSync(location, "utf8"))?.version;
      if (typeof version === "string" && version) return version;
    } catch {
      continue;
    }
  }
  throw new Error("could not resolve @dbx-tools/cli-model-proxy version");
}

/** Build the model-proxy command group without installing Python or starting a process. */
export function buildProgram(
  name = "dbx model-proxy",
  dependencies: ModelProxyCliDependencies = DEFAULT_DEPENDENCIES,
): Command {
  return new Command()
    .name(name)
    .description("Run or manage the Python Databricks model proxy")
    .argument("[args...]", "arguments forwarded to dbx-model-proxy")
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .action(async (args: string[]) => {
      await run(args, dependencies);
    });
}
