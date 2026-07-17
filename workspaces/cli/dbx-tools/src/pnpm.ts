/**
 * pnpm discovery, workspace install, and projen forwarding for the `dbxtools` CLI.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { exec } from "@dbx-tools/core";
import { functionModule } from "@dbx-tools/shared-core";
import { needsInstall } from "./root";

/** A package.json `bin` field: either a single command string, or a name -> path map. */
type BinField = string | Record<string, string>;

/** True when `pnpm --version` runs, i.e. pnpm is already on PATH. */
function pnpmOnPath(): boolean {
  try {
    exec.spawnSync("pnpm", ["--version"], {
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
      check: true,
    });
    return true;
  } catch {
    return false;
  }
}

function resolvePnpmArgvImpl(): string[] {
  // 1. A resolvable `pnpm` dependency (the normal in-workspace case): run its
  //    bin directly with the current node - no PATH or package-manager shim.
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve("pnpm/package.json");
    const pkg = require(pkgJsonPath) as { bin: BinField };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pnpm;
    return [process.execPath, join(dirname(pkgJsonPath), bin)];
  } catch {
    // fall through
  }

  // 2. A bare `pnpm` already on PATH (e.g. running under `pnpm dlx`). Prefer
  //    this over the corepack/npx fallbacks so we never shell through npm -
  //    `npx -y pnpm` runs under npm, which rejects a bootstrapped
  //    `devEngines.packageManager: pnpm` manifest with EBADDEVENGINES.
  if (pnpmOnPath()) return ["pnpm"];

  // 3. Try to enable pnpm via corepack, then use it.
  try {
    exec.spawnSync("corepack", ["enable", "pnpm"], {
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
      check: true,
    });
    if (pnpmOnPath()) return ["pnpm"];
  } catch {
    // fall through
  }

  // 4. Last resort: fetch pnpm on demand via npx. Pass `--engine-strict=false`
  //    (and skip npm's devEngines gate) so npm doesn't refuse to run just
  //    because the target manifest declares `devEngines.packageManager: pnpm`.
  return ["npx", "-y", "--engine-strict=false", "pnpm"];
}

/** Memoized `[command, ...prefix]` argv prefix to run pnpm (resolved install, else corepack, else npx). */
export const resolvePnpmArgv = functionModule.memoize(resolvePnpmArgvImpl);

/** Run pnpm with inherited stdio from `cwd`. */
export function runPnpm(args: string[], cwd: string): void {
  const [command, ...prefix] = resolvePnpmArgv();
  exec.spawnSync(command, [...prefix, ...args], { cwd, check: true });
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
