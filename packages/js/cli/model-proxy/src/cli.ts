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
const COMPANION = releaseBinaryCommand("model-proxy-desktop");
const execFileAsync = promisify(execFile);

async function installRequirements(
  proxy: string,
  installArgs: readonly string[],
  companion?: string,
): Promise<{ companionAssetRequired: boolean; installArgs: string[] }> {
  const { stdout } = await execFileAsync(
    proxy,
    [
      "service",
      "requirements",
      ...(companion ? ["--companion", companion] : []),
      "--",
      ...installArgs,
    ],
    { encoding: "utf8" },
  );
  const requirements = json.parseRecord(stdout);
  if (
    typeof requirements?.companion_asset_required !== "boolean" ||
    !Array.isArray(requirements.install_args) ||
    !requirements.install_args.every((argument) => typeof argument === "string")
  ) {
    throw new Error("model proxy returned invalid service requirements");
  }
  return {
    companionAssetRequired: requirements.companion_asset_required,
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
    const original = args.slice(2);
    let requirements = await installRequirements(proxy.path, original);
    if (requirements.companionAssetRequired) {
      const companion = await ensureReleaseBinary(COMPANION);
      requirements = await installRequirements(proxy.path, original, companion.path);
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
