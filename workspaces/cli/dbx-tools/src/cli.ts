/**
 * `dbxtools` commander entry: detect root, bootstrap or install, forward to projen.
 */
import { Command } from "commander";
import { bootstrapWorkspace } from "./bootstrap";
import { ensureWorkspaceReady, runProjen } from "./pnpm";
import { findWorkspaceRoot, needsBootstrap } from "./root";

/**
 * Prepare the workspace at `root`, then run `pnpm exec projen` with `projenArgs`.
 */
async function prepareAndRunProjen(projenArgs: string[], startDir?: string): Promise<void> {
  const root = await findWorkspaceRoot(startDir);
  if (needsBootstrap(root)) {
    bootstrapWorkspace(root);
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
