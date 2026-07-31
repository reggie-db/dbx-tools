/**
 * pnpm discovery, workspace install, and projen forwarding for the `dbx-tools` CLI.
 *
 * @module
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { exec, project } from "@dbx-tools/core";
import { functionModule, log, net } from "@dbx-tools/shared-core";
import { needsInstall } from "./root.ts";

const logger = log.logger("dbx-tools:pnpm");

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
  const registryUrl = project.npmRegistry(null, { overrideOnly: true, envVars: true })?.toString();
  const registryArgs: string[] = registryUrl ? ["--registry", registryUrl] : [];

  // A resolvable `pnpm` dependency (in-workspace case): run its bin directly with node
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve("pnpm/package.json");
    const pkg = require(pkgJsonPath) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pnpm;

    if (bin) {
      // NOTE: registryArgs MUST come AFTER the script entrypoint when invoking node directly
      return [process.execPath, join(dirname(pkgJsonPath), bin), ...registryArgs];
    }
  } catch {
    // fall through
  }

  // Bare `pnpm` on PATH (e.g., under `pnpm dlx`)
  if (pnpmOnPath()) return ["pnpm", ...registryArgs];

  // Enable pnpm via corepack, then use it
  try {
    exec.spawnSync("corepack", ["enable", "pnpm"], {
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
      check: true,
    });
    if (pnpmOnPath()) return ["pnpm", ...registryArgs];
  } catch {
    // fall through
  }

  // Fallback: npx (npm-level flags like --registry and --engine-strict come BEFORE package name)
  return ["npx", ...registryArgs, "-y", "--engine-strict=false", "pnpm"];
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


