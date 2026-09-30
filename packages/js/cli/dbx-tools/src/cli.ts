/**
 * Commander entry for `dbx` and its `dbx-tools` alias.
 *
 * `dev` forwards to the pinned Bazel toolchain in an existing workspace.
 * `appkit` provides AppKit environment helpers.
 * `auth` manages Databricks OAuth and access tokens.
 * `tunnel` runs a public portr tunnel with passwordless access gating.
 *
 * Feature commands load their sibling packages only when selected and forward
 * their complete argument list, including `--help`.
 *
 * @module
 */
import { basename } from "node:path";
import { Command } from "commander";
import { runBazel } from "./bun.ts";
import { findWorkspaceRoot } from "./root.ts";
import {
  runRustReleaseBinary,
  rustReleaseBinaryCommands,
  type RustReleaseBinaryCommand,
} from "./rust-binary.ts";

/** Commands the bin exposes, and the names help is rendered under. */
const PROGRAM_NAMES = ["dbx", "dbx-tools"] as const;

export async function prepareAndRunBazel(args: string[], startDir?: string): Promise<void> {
  const root = await findWorkspaceRoot(startDir);
  runBazel(args.length ? args : ["build", "//..."], root);
}

/**
 * Mount `name` as a command that captures every following token verbatim and
 * hands it to the program `load()` resolves. `helpOption(false)` is what lets
 * `--help` through to the child instead of being answered here, and the child
 * program owns its own flags, so this wrapper never has to restate them.
 */
function addForwardedCommand(
  program: Command,
  name: string,
  description: string,
  load: () => Promise<(name: string) => Command>,
): void {
  program
    .command(name)
    .description(description)
    .argument("[args...]", `arguments forwarded to ${name}`)
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .action(async (args: string[]) => {
      const buildProgram = await load();
      await buildProgram(`${program.name()} ${name}`).parseAsync(args, { from: "user" });
    });
}

function addRustReleaseCommand(program: Command, command: RustReleaseBinaryCommand): void {
  program
    .command(command.command)
    .description(command.description)
    .argument("[args...]", `arguments forwarded to ${command.binaryName}`)
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .action(async (args: string[]) => {
      process.exitCode = await runRustReleaseBinary(command, args);
    });
}

/** Build the `dbx` commander program (no side effects until parsed). */
export function buildProgram(name: string = PROGRAM_NAMES[0]): Command {
  const program = new Command()
    .name(name)
    .description(
      "Databricks developer tools: workspace lifecycle, AppKit env, auth, tunnels, and native proxies",
    )
    .showHelpAfterError()
    .helpOption("-h, --help", `Show ${name} help`);

  program
    .command("dev")
    .description("Run Bazel in the current workspace")
    .argument("[bazelArgs...]", "Bazel command and arguments (e.g. build //...)")
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .action(async (bazelArgs: string[]) => {
      await prepareAndRunBazel(bazelArgs);
    });

  addForwardedCommand(
    program,
    "appkit",
    "AppKit helpers (env: print the environment an AppKit app resolves)",
    async () => (await import("@dbx-tools/cli-appkit-env/cli")).buildProgram,
  );

  addForwardedCommand(
    program,
    "auth",
    "Authenticate to Databricks and manage OAuth tokens",
    async () => (await import("@dbx-tools/cli-auth/cli")).buildProgram,
  );

  addForwardedCommand(
    program,
    "tunnel",
    "Run a public portr tunnel with an email-OTP gate",
    async () => (await import("@dbx-tools/cli-tunnel/cli")).buildProgram,
  );

  for (const command of rustReleaseBinaryCommands()) {
    addRustReleaseCommand(program, command);
  }

  return program;
}

/**
 * Program name for help output: whichever bin the user actually typed, so
 * `dbx-tools --help` doesn't document itself as `dbx`. Falls back to `dbx`.
 */
function programName(argv: string[]): string {
  const invoked = argv[1] ? basename(argv[1]).replace(/\.(?:[cm]?[jt]s)$/, "") : undefined;
  return PROGRAM_NAMES.find((candidate) => candidate === invoked) ?? PROGRAM_NAMES[0];
}

/** Parse `argv` (a `process.argv`) and run the matching command. */
export async function runCli(argv: string[]): Promise<void> {
  await buildProgram(programName(argv)).parseAsync(argv);
}
