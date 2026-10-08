/**
 * Commander entry for `dbx` and its `dbx-tools` alias.
 *
 * `dev` bootstraps or repairs a workspace and forwards to projen.
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
import {
  bootstrapWorkspace,
  ensureEngineCurrent,
  runInitialSynth,
  seedToolchain,
} from "./bootstrap.ts";
import { ensureWorkspaceReady, runBun, runProjen } from "./bun.ts";
import { findWorkspaceRoot, needsBootstrap, needsToolchain } from "./root.ts";

/** Commands the bin exposes, and the names help is rendered under. */
const PROGRAM_NAMES = ["dbx", "dbx-tools"] as const;

/**
 * Prepare the workspace at `root`, then run projen (via bun) with `projenArgs`.
 *
 * Three cases, in order:
 *   - no `.projenrc.ts` at all -> full bootstrap (scaffold + install + synth),
 *     which already runs the initial synth; nothing more to forward.
 *   - a `.projenrc.ts` but the engine/toolchain isn't installed (e.g. a freshly
 *     copied project whose generated files + manifests are gitignored) -> seed
 *     the toolchain, then run the INITIAL synth directly (the projen tasks the
 *     args would name, like `sync`, don't exist until `.projenrc.ts` has run
 *     once), and install. Don't forward `projenArgs` - the synth is the work.
 *   - otherwise (established workspace) -> ensure deps, bring the engine up to
 *     this CLI's version, then forward to projen.
 */
export async function prepareAndRunProjen(projenArgs: string[], startDir?: string): Promise<void> {
  const root = await findWorkspaceRoot(startDir);
  if (needsBootstrap(root)) {
    bootstrapWorkspace(root);
    return;
  }
  if (needsToolchain(root)) {
    seedToolchain(root);
    runInitialSynth(root);
    runBun(["install"], root);
    return;
  }
  ensureWorkspaceReady(root);
  ensureEngineCurrent(root);
  runProjen(projenArgs, root);
}

/**
 * Mount `name` as a command that captures every following token verbatim and
 * hands it to the program `load()` resolves. `helpOption(false)` is what lets
 * `--help` through to the child instead of being answered here, and
 * `passThroughOptions()` keeps unknown flags in that token list so the child
 * program owns them.
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
    .passThroughOptions()
    .allowExcessArguments()
    .helpOption(false)
    .action(async (args: string[]) => {
      const buildProgram = await load();
      await buildProgram(`${program.name()} ${name}`).parseAsync(args, { from: "user" });
    });
}

/** Build the `dbx` commander program (no side effects until parsed). */
export function buildProgram(name: string = PROGRAM_NAMES[0]): Command {
  const program = new Command()
    .name(name)
    .description(
      "Databricks developer tools: workspace lifecycle, AppKit env, auth, tunnels, and local proxies",
    )
    .enablePositionalOptions()
    .showHelpAfterError()
    .helpOption("-h, --help", `Show ${name} help`);

  program
    .command("dev")
    .description("Bootstrap or repair a dbx-tools workspace, then forward to projen")
    .argument("[projenArgs...]", "projen task and arguments (e.g. sync --watch)")
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .action(async (projenArgs: string[]) => {
      await prepareAndRunProjen(projenArgs);
    });

  addForwardedCommand(
    program,
    "appkit",
    "AppKit helpers (env: print the environment an AppKit app resolves)",
    async () => (await import("./appkit/cli.ts")).buildProgram,
  );

  addForwardedCommand(
    program,
    "auth",
    "Authenticate to Databricks and manage OAuth tokens",
    async () => (await import("./auth/cli.ts")).buildProgram,
  );

  addForwardedCommand(
    program,
    "tunnel",
    "Run a public portr tunnel with an email-OTP gate",
    async () => (await import("./tunnel/cli.ts")).buildProgram,
  );

  addForwardedCommand(
    program,
    "lakebase-proxy",
    "Run the Node Databricks Lakebase PostgreSQL proxy",
    async () => (await import("./lakebase-proxy/cli.ts")).buildProgram,
  );

  addForwardedCommand(
    program,
    "model-gateway",
    "Run the foreground AppKit Databricks model gateway",
    async () => (await import("./model-gateway/cli.ts")).buildProgram,
  );

  addForwardedCommand(
    program,
    "genie",
    "Run managed Genie Code through a local Databricks model gateway",
    async () => (await import("./genie-code/cli.ts")).buildProgram,
  );

  addForwardedCommand(
    program,
    "graphiti",
    "Run Graphiti or manage its current-user desktop service",
    async () => (await import("./graphiti/cli.ts")).buildProgram,
  );

  return program;
}

/** Build the complete command tree used for generated documentation. */
export async function buildDocumentationProgram(name: string = PROGRAM_NAMES[0]): Promise<Command> {
  const program = buildProgram(name);
  (program.commands as Command[]).splice(
    1,
    program.commands.length - 1,
    (await import("./appkit/cli.ts")).buildProgram("appkit"),
    (await import("./auth/cli.ts")).buildProgram("auth"),
    (await import("./tunnel/cli.ts")).buildProgram("tunnel"),
    (await import("./lakebase-proxy/cli.ts")).buildProgram("lakebase-proxy"),
    (await import("./model-gateway/cli.ts")).buildProgram("model-gateway"),
    (await import("./genie-code/cli.ts")).buildProgram("genie"),
    (await import("./graphiti/cli.ts")).buildProgram("graphiti"),
  );
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
