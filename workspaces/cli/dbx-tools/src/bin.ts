/**
 * Binary discovery and execution (pnpm, engine bin scripts).
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { workspace } from "@dbx-tools/shared-projen";

/** A package.json `bin` field: either a single command string, or a name -> path map. */
type BinField = string | Record<string, string>;

/** Absolute path to this CLI package root (the folder that contains `bin/`). */
export const ENGINE_PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let resolvedEnginePkgRoot: string | undefined;

/**
 * Absolute path to the published `dbx-tools` package root when installed from npm.
 *
 * Falls back to {@link ENGINE_PKG_ROOT} when running from the in-repo source tree.
 */
export function resolveEnginePkgRoot(): string {
  if (resolvedEnginePkgRoot) return resolvedEnginePkgRoot;
  try {
    const require = createRequire(import.meta.url);
    resolvedEnginePkgRoot = dirname(require.resolve("dbx-tools/package.json"));
  } catch {
    resolvedEnginePkgRoot = ENGINE_PKG_ROOT;
  }
  return resolvedEnginePkgRoot;
}

export function engineBinScript(name: string): string {
  return join(resolveEnginePkgRoot(), "bin", name);
}

/** Projen task exec: `tsx <rel>/bin/<script>` from the monorepo root. */
export function tsxBinTaskExec(root: string, script: string, args = ""): string {
  const rel = workspace.toPosix(relative(root, engineBinScript(script)));
  return args ? `tsx ${rel} ${args}` : `tsx ${rel}`;
}

/** `[command, ...prefix]` argv prefix to run pnpm via this package's dependency. */
export function resolvePnpmArgv(): string[] {
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve("pnpm");
    const pkg = require(pkgJsonPath) as { bin: BinField };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pnpm;
    return [process.execPath, join(dirname(pkgJsonPath), bin)];
  } catch {
    return ["npx", "-y", "pnpm"];
  }
}

export function runPnpm(args: string[], cwd: string = workspace.repoRoot): void {
  const [command, ...prefix] = resolvePnpmArgv();
  execFileSync(command, [...prefix, ...args], { cwd, stdio: "inherit" });
}
