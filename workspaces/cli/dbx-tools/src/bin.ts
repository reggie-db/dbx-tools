/**
 * Binary discovery and execution (pnpm, engine bin scripts).
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, toPosix } from "./projen/workspace";

/** A package.json `bin` field: either a single command string, or a name -> path map. */
type BinField = string | Record<string, string>;

/** Absolute path to the engine package root (the folder that contains `bin/`). */
export const ENGINE_PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function engineBinScript(name: string): string {
  return join(ENGINE_PKG_ROOT, "bin", name);
}

/** Projen task exec: `tsx <rel>/bin/<script>` from the monorepo root. */
export function tsxBinTaskExec(root: string, script: string, args = ""): string {
  const rel = toPosix(relative(root, engineBinScript(script)));
  return args ? `tsx ${rel} ${args}` : `tsx ${rel}`;
}

/** `[command, ...prefix]` argv prefix to run pnpm via the engine's dependency. */
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

export function runPnpm(args: string[], cwd: string = repoRoot): void {
  const [command, ...prefix] = resolvePnpmArgv();
  execFileSync(command, [...prefix, ...args], { cwd, stdio: "inherit" });
}
