/**
 * pnpm subprocess helpers for the projen engine.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { repoRoot } from "./workspace";

/** A package.json `bin` field: either a single command string, or a name -> path map. */
type BinField = string | Record<string, string>;

/** `[command, ...prefix]` argv prefix to run pnpm via a resolved dependency. */
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
