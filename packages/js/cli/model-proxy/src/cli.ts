/**
 * `dbx model-proxy` direct execution and per-user service lifecycle.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ensureReleaseBinary,
  releaseBinaryCommand,
  runReleaseBinary,
} from "@dbx-tools/rust-binary";
import { json } from "@dbx-tools/shared-core";
import { Command } from "commander";

const PROXY = releaseBinaryCommand("model-proxy");
const DESKTOP = releaseBinaryCommand("model-proxy-desktop");
const execFileAsync = promisify(execFile);

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
 * `argv` so `service requirements` still parses server flags after `--`.
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

async function installRequirements(
  proxy: string,
  installArgs: readonly string[],
  desktop?: string,
): Promise<{ desktopAssetRequired: boolean; installArgs: string[] }> {
  const { stdout } = await execFileAsync(
    proxy,
    [
      "service",
      "requirements",
      ...(desktop ? ["--desktop-executable", desktop] : []),
      "--",
      ...installArgs,
    ],
    { encoding: "utf8" },
  );
  const requirements = json.parseRecord(stdout);
  if (
    typeof requirements?.desktop_asset_required !== "boolean" ||
    !Array.isArray(requirements.install_args) ||
    !requirements.install_args.every((argument) => typeof argument === "string")
  ) {
    throw new Error("model proxy returned invalid service requirements");
  }
  return {
    desktopAssetRequired: requirements.desktop_asset_required,
    installArgs: requirements.install_args,
  };
}

async function run(args: readonly string[]): Promise<void> {
  let forwarded = [...args];
  if (
    args[0] === "service" &&
    args[1] === "install" &&
    !args.includes("--help") &&
    !args.includes("-h")
  ) {
    const proxy = await ensureReleaseBinary(PROXY);
    const original = restoreInstallArgs(args);
    let requirements = await installRequirements(proxy.path, original);
    if (requirements.desktopAssetRequired) {
      const desktop = await ensureReleaseBinary(DESKTOP);
      requirements = await installRequirements(proxy.path, original, desktop.path);
    }
    forwarded = ["service", "install", ...requirements.installArgs];
  }
  process.exitCode = await runReleaseBinary(PROXY, forwarded);
}

/** Build the model-proxy command group without downloading a binary. */
export function buildProgram(name = "dbx model-proxy"): Command {
  const program = new Command()
    .name(name)
    .description("Run or manage the native Databricks model proxy")
    .argument("[args...]", "arguments forwarded to dbx-model-proxy")
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .action(async (args: string[]) => {
      await run(args);
    });
  return program;
}
