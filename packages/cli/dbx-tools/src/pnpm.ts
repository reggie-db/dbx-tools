/**
 * pnpm discovery, workspace install, and projen forwarding for the `dbx-tools` CLI.
 *
 * @module
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { exec, project } from "@dbx-tools/core";
import { functionModule, log } from "@dbx-tools/shared-core";
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
  const env = { ...process.env };
  const registryUrl = project.npmRegistry()?.toString();
  logger.info(`running pnpm with registry url: ${registryUrl}`);
  if (registryUrl) {
    [false, true].forEach(upperCase => {
      const key = "npm_config_registry"
      env[upperCase ? key.toUpperCase() : key] = registryUrl;
    });
  }
  exec.spawnSync(command, [...prefix, ...args], { cwd, check: true, env: env });
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
