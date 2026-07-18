/**
 * `dbxtools` commander entry: detect root, bootstrap or install, forward to projen.
 *
 * @module
 */
import { Command } from "commander";
import { bootstrapWorkspace, runInitialSynth, seedToolchain } from "./bootstrap";
import { ensureWorkspaceReady, runPnpm, runProjen } from "./pnpm";
import { findWorkspaceRoot, needsBootstrap, needsToolchain } from "./root";

/**
 * Prepare the workspace at `root`, then run `pnpm exec projen` with `projenArgs`.
 *
 * Three cases, in order:
 *   - no `.projenrc.ts` at all -> full bootstrap (scaffold + install + synth),
 *     which already runs the initial synth; nothing more to forward.
 *   - a `.projenrc.ts` but the engine/toolchain isn't installed (e.g. a freshly
 *     copied project whose generated files + manifests are gitignored) -> seed
 *     the toolchain, then run the INITIAL synth directly (the projen tasks the
 *     args would name, like `sync`, don't exist until `.projenrc.ts` has run
 *     once), and install. Don't forward `projenArgs` - the synth is the work.
 *   - otherwise (established workspace) -> ensure deps, then forward to projen.
 */
async function prepareAndRunProjen(projenArgs: string[], startDir?: string): Promise<void> {
  const root = await findWorkspaceRoot(startDir);
  if (needsBootstrap(root)) {
    bootstrapWorkspace(root);
    return;
  }
  if (needsToolchain(root)) {
    seedToolchain(root);
    runInitialSynth(root);
    runPnpm(["install", "--no-frozen-lockfile", "--force"], root);
    return;
  }
  ensureWorkspaceReady(root);
  runProjen(projenArgs, root);
}

/** Parse `argv` with commander and forward remaining args to projen. */
export async function runCli(argv: string[]): Promise<void> {
  const program = new Command()
    .name("dbxtools")
    .description("Bootstrap dbx-tools workspaces and forward to projen")
    .allowUnknownOption()
    .allowExcessArguments()
    .showHelpAfterError()
    .helpOption("-h, --help", "Show dbxtools help");

  program.parse(argv);
  await prepareAndRunProjen(program.args);
}
