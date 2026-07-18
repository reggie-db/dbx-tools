/**
 * Workspace root detection for the `dbxtools` CLI.
 *
 * @module
 */
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { exec } from "@dbx-tools/core";
import { functionModule } from "@dbx-tools/shared-core";

async function gitToplevel(): Promise<string | undefined> {
  const { exitCode, stdout } = await exec.spawn("git", ["rev-parse", "--show-toplevel"], {
    stdout: "capture",
    stderr: "ignore",
    stdin: "ignore",
  });
  if (exitCode !== 0) return undefined;
  return stdout || undefined;
}

/**
 * Walk upward from `startDir` for `.projenrc.ts`. If none is found, try git
 * top-level only when that directory also contains `.projenrc.ts`; otherwise return
 * `resolve(startDir)` (which may not be a workspace root).
 */
export async function findWorkspaceRoot(startDir: string = process.cwd()): Promise<string> {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".projenrc.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const fromGit = await gitToplevel();
  if (fromGit && existsSync(join(fromGit, ".projenrc.ts"))) return fromGit;

  return resolve(startDir);
}

/**
 * True when the folder has no `.projenrc.ts` yet and needs full bootstrapping.
 * Keying off `.projenrc.ts` (not `package.json`) avoids clobbering a cleaned
 * workspace that still has a hand-authored projenrc.
 */
export function needsBootstrap(root: string): boolean {
  return !existsSync(join(root, ".projenrc.ts"));
}

/** True when `node_modules` or projen itself is missing under `root`. */
export function needsInstall(root: string): boolean {
  if (!existsSync(join(root, "node_modules"))) return true;
  if (existsSync(join(root, ".projenrc.ts")) && !existsSync(join(root, "node_modules", "projen"))) {
    return true;
  }
  return false;
}

/**
 * True when the synth TOOLCHAIN isn't installed yet: no `node_modules`, or the
 * dbx-tools engine / `projen` aren't resolvable under it. Distinct from a full
 * bootstrap (which keys off a MISSING `.projenrc.ts`): here the projenrc exists
 * but its dependencies don't - e.g. a copied project whose generated manifests
 * and `node_modules` are gitignored. Seeding the toolchain (not scaffolding)
 * makes it synth-ready without touching the hand-authored `.projenrc.ts`.
 */
export function needsToolchain(root: string): boolean {
  const modules = join(root, "node_modules");
  if (!existsSync(modules)) return true;
  return (
    !existsSync(join(modules, "projen")) ||
    !existsSync(join(modules, "@dbx-tools", "projen"))
  );
}

/** Async, memoized root lookup from the process cwd at first use. */
export const workspaceRoot = functionModule.memoize(() => findWorkspaceRoot());

/** Short label for log output (`basename` of the resolved root). */
export function rootLabel(root: string): string {
  return basename(root) || root;
}
