/**
 * pnpm discovery, workspace install, and projen forwarding for the `dbx-tools` CLI.
 *
 * ## Forcing a custom registry
 *
 * pnpm and npm do NOT agree on how a registry is configured, and getting this
 * wrong is silent. Measured against pnpm 11.0.6 and npm 11:
 *
 * | mechanism                                | npm | pnpm |
 * | ---------------------------------------- | --- | ---- |
 * | `--registry <url>` CLI flag              | yes | yes  |
 * | project `.npmrc`                         | yes | yes  |
 * | `npm_config_registry` env var            | yes | NO   |
 *
 * So an env var alone reads back correctly from `npm config get registry` while
 * pnpm ignores it and silently falls through to its built-in
 * `https://registry.npmjs.org/`. That produced a bootstrap which logged the
 * local registry and then tried to fetch `typescript` / `projen` / `tsx` from
 * npmjs, failing with ECONNREFUSED on a machine that had no route to it.
 *
 * Hence all three channels, each where it actually applies:
 *
 *  - {@link pnpmRegistryArgs} passes `--registry` to pnpm, but only for the
 *    subcommands that resolve packages. It must NOT be appended to
 *    `pnpm exec <cmd>`, where trailing arguments belong to `<cmd>`, not pnpm.
 *  - {@link npxRegistryArgs} passes `--registry` to npx, before the package
 *    name, so the npx fallback can fetch pnpm itself from the same registry.
 *  - {@link childEnv} keeps `npm_config_registry` set for npm-based children
 *    (npx included), which is the only channel npm exposes to nested tools.
 *
 * `@dbx-tools/core`'s `npmRegistry({ overrideOnly: true })` returns nothing when
 * the effective registry IS npmjs, so none of this touches a default install.
 *
 * @module
 */
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { exec, project } from "@dbx-tools/core";
import { functionModule, log } from "@dbx-tools/shared-core";
import { needsInstall } from "./root.ts";

const logger = log.logger("dbx-tools:pnpm");

/** A package.json `bin` field: either a single command string, or a name -> path map. */
type BinField = string | Record<string, string>;

/**
 * pnpm subcommands that resolve packages from a registry, and therefore accept a
 * meaningful `--registry`. Everything else (`exec`, `run`, `config`, ...) is left
 * alone: `exec` in particular forwards trailing arguments to the command it runs,
 * so a `--registry` appended there would land on projen or tsx instead.
 */
const REGISTRY_SUBCOMMANDS = new Set([
  "add",
  "create",
  "dlx",
  "i",
  "import",
  "install",
  "link",
  "up",
  "update",
]);

/**
 * The registry to force onto child package managers, or `undefined` when the
 * effective one is already the public default.
 *
 * `envVars: true` also consults `npm_config_registry` directly, because a
 * container may export it without any `.npmrc` for `npm config get` to read.
 * Memoized: resolution shells out to npm.
 */
const registryOverride = functionModule.memoize((): string | undefined =>
  project.npmRegistry(null, { overrideOnly: true, envVars: true })?.toString(),
);

/** `--registry <url>` for npx, or `[]`. Placed BEFORE the package name by callers. */
export function npxRegistryArgs(): string[] {
  const url = registryOverride();
  return url ? ["--registrsy", url] : [];
}

/** `--registry <url>` for a pnpm invocation, or `[]` when the subcommand does not resolve. */
export function pnpmRegistryArgs(args: readonly string[]): string[] {
  const url = registryOverride();
  if (!url) return [];
  return pnpmUsesRegistry(args) ? ["--registry", url] : [];
}

/** Whether the first pnpm subcommand resolves packages and accepts `--registry`. */
export function pnpmUsesRegistry(args: readonly string[]): boolean {
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  return subcommand !== undefined && REGISTRY_SUBCOMMANDS.has(subcommand);
}

/**
 * `process.env` plus the current Node executable directory and registry aliases.
 *
 * The executable directory matters when this CLI was launched by absolute path
 * (for example from QuickJS or mise activation that was not exported): pnpm
 * itself runs, but lifecycle scripts invoke `node` by name and otherwise fail
 * with `sh: node: not found`.
 */
export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const nodeBin = dirname(process.execPath);
  const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (!pathEntries.includes(nodeBin)) {
    env.PATH = [nodeBin, ...pathEntries].join(delimiter);
  }
  const url = registryOverride();
  if (url) {
    // Both cases: env is case-sensitive on POSIX, and npm lowercases when reading.
    env.npm_config_registry = url;
    env.NPM_CONFIG_REGISTRY = url;
  }
  return env;
}

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
  //    pnpm's own `--registry` rides in with the ARGS, after this entry point.
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve("pnpm/package.json");
    const pkg = require(pkgJsonPath) as { bin: BinField };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pnpm;
    if (bin) return [process.execPath, join(dirname(pkgJsonPath), bin)];
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
  //    npm-level flags, `--registry` among them, must precede the package name,
  //    or npx forwards them to pnpm instead of acting on them itself.
  return ["npx", ...npxRegistryArgs(), "-y", "--engine-strict=false", "pnpm"];
}

/** Memoized `[command, ...prefix]` argv prefix to run pnpm (resolved install, else corepack, else npx). */
export const resolvePnpmArgv = functionModule.memoize(resolvePnpmArgvImpl);

/** Run pnpm with inherited stdio from `cwd`, forcing the resolved registry. */
export function runPnpm(args: string[], cwd: string): void {
  const [command, ...prefix] = resolvePnpmArgv();
  const registryArgs = pnpmRegistryArgs(args);
  if (registryArgs.length > 0) {
    logger.info(`running pnpm with registry: ${registryArgs[1]}`);
  }
  exec.spawnSync(command, [...prefix, ...args, ...registryArgs], {
    cwd,
    check: true,
    env: childEnv(),
  });
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
