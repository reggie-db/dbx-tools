/**
 * `dbxtools` commander entry: detect root, bootstrap or install, forward to projen.
 */
import { Command } from "commander";
import { bootstrapWorkspace, seedToolchain } from "./bootstrap";
import { ensureWorkspaceReady, runProjen } from "./pnpm";
import { findWorkspaceRoot, needsBootstrap, needsToolchain } from "./root";

/**
 * Prepare the workspace at `root`, then run `pnpm exec projen` with `projenArgs`.
 *
 * Three cases, in order:
 *   - no `.projenrc.ts` at all -> full bootstrap (scaffold + install + synth).
 *   - a `.projenrc.ts` but the engine/toolchain isn't installed (e.g. a freshly
 *     copied project whose generated files + manifests are gitignored) -> seed
 *     the toolchain so the synth below can regenerate everything, WITHOUT
 *     overwriting the hand-authored `.projenrc.ts`.
 *   - otherwise -> just ensure deps are installed.
 */
async function prepareAndRunProjen(projenArgs: string[], startDir?: string): Promise<void> {
  const root = await findWorkspaceRoot(startDir);
  if (needsBootstrap(root)) {
    bootstrapWorkspace(root);
  } else if (needsToolchain(root)) {
    seedToolchain(root);
  } else {
    ensureWorkspaceReady(root);
  }
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
