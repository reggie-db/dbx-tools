/**
 * pnpm discovery, workspace install, and projen forwarding for the `dbxtools` CLI.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { functionModule } from "@dbx-tools/shared-core";
import { needsInstall } from "./root";

/** A package.json `bin` field: either a single command string, or a name -> path map. */
type BinField = string | Record<string, string>;

function resolvePnpmArgvImpl(): string[] {
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve("pnpm/package.json");
    const pkg = require(pkgJsonPath) as { bin: BinField };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pnpm;
    return [process.execPath, join(dirname(pkgJsonPath), bin)];
  } catch {
    try {
      execFileSync("corepack", ["enable", "pnpm"], { stdio: "ignore" });
      execFileSync("pnpm", ["--version"], { stdio: "ignore" });
      return ["pnpm"];
    } catch {
      return ["npx", "-y", "pnpm"];
    }
  }
}

/** Memoized `[command, ...prefix]` argv prefix to run pnpm via a resolved dependency. */
export const resolvePnpmArgv = functionModule.memoize(resolvePnpmArgvImpl);

/** Run pnpm with inherited stdio from `cwd`. */
export function runPnpm(args: string[], cwd: string): void {
  const [command, ...prefix] = resolvePnpmArgv();
  execFileSync(command, [...prefix, ...args], { cwd, stdio: "inherit" });
}

/** Install workspace dependencies when `node_modules` or projen is missing. */
export function ensureWorkspaceReady(root: string): void {
  if (needsInstall(root)) {
    runPnpm(["install", "--no-frozen-lockfile"], root);
  }
}

/** Run `pnpm exec projen` with the given args from `root`. */
export function runProjen(args: string[], root: string): void {
  runPnpm(["exec", "projen", ...args], root);
}
