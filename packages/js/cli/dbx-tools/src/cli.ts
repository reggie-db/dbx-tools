/**
 * The single `dbx` (alias `dbx-tools`) commander entry.
 *
 * One bin, three command groups:
 *   - `dev` - workspace lifecycle: detect the root, bootstrap or repair, then
 *     forward whatever follows to projen. This is the passthrough, and it is an
 *     EXPLICIT subcommand rather than the bare root action so a projen task
 *     name can never shadow (or be shadowed by) a sibling command.
 *   - `model-proxy` - the local OpenAI-compatible Model Serving proxy.
 *   - `appkit` - AppKit environment helpers (`appkit env`).
 *
 * The two feature groups stay in their own packages (`@dbx-tools/cli-model-proxy`,
 * `@dbx-tools/cli-appkit-env`) and are `await import()`ed only once their name is
 * matched, so `dbx dev` never loads the Databricks SDK or AppKit. That lazy hop
 * is also why they are mounted as ARG-FORWARDING commands instead of
 * `addCommand()`: building a child program eagerly to register it would defeat
 * the point. Each forwards its own `--help`, so the child prints its real help.
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

/** Build the `dbx` commander program (no side effects until parsed). */
export function buildProgram(name: string = PROGRAM_NAMES[0]): Command {
  const program = new Command()
    .name(name)
    .description("Databricks developer tools: workspace lifecycle, model proxy, AppKit env")
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
    "model-proxy",
    "Serve a local OpenAI-compatible proxy in front of Databricks Model Serving",
    async () => (await import("@dbx-tools/cli-model-proxy/cli")).buildProgram,
  );

  addForwardedCommand(
    program,
    "appkit",
    "AppKit helpers (env: print the environment an AppKit app resolves)",
    async () => (await import("@dbx-tools/cli-appkit-env/cli")).buildProgram,
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
