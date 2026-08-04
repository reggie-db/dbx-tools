/**
 * bun discovery, workspace install, and projen forwarding for the `dbx-tools` CLI.
 *
 * ## Forcing a custom registry
 *
 * bun honors a `--registry <url>` flag on `bun install`/`bun add` and a project
 * `.npmrc`, but (like pnpm) ignores the `npm_config_registry` env var for its own
 * resolution. So a custom registry is forced through TWO channels, each where it
 * applies:
 *
 *  - {@link bunRegistryArgs} passes `--registry` to the package-resolving
 *    subcommands (`install`/`add`/`update`), never to `bun run`/`bunx`, whose
 *    trailing args belong to the script.
 *  - {@link childEnv} keeps `.npmrc`-style env aliases set for any nested
 *    npm-based tool, and (critically) puts the bun/node executable dir on PATH so
 *    a lifecycle script can invoke the runtime by bare name.
 *
 * `@dbx-tools/core`'s `npmRegistry({ overrideOnly: true })` returns nothing when
 * the effective registry IS npmjs, so none of this touches a default install.
 *
 * @module
 */
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { exec, project } from "@dbx-tools/core";
import { functionModule, log } from "@dbx-tools/shared-core";
import { needsInstall } from "./root.ts";

const logger = log.logger("dbx-tools:bun");

/**
 * bun subcommands that resolve packages from a registry, and therefore accept a
 * meaningful `--registry`. Everything else (`run`, `x`, `pm`, ...) is left alone:
 * `run`/`x` forward trailing arguments to the script they run.
 */
const REGISTRY_SUBCOMMANDS = new Set(["add", "install", "i", "update", "up"]);

/**
 * The registry to force onto child installs, or `undefined` when the effective
 * one is already the public default.
 *
 * `envVars: true` also consults `npm_config_registry` directly, because a
 * container may export it without any `.npmrc` for lookup. Memoized: resolution
 * shells out.
 */
const registryOverride = functionModule.memoize((): string | undefined =>
  project.npmRegistry(null, { overrideOnly: true, envVars: true })?.toString(),
);

/** `--registry <url>` for a bun invocation, or `[]` when the subcommand doesn't resolve. */
export function bunRegistryArgs(args: readonly string[]): string[] {
  const url = registryOverride();
  if (!url) return [];
  return bunUsesRegistry(args) ? ["--registry", url] : [];
}

/** Whether the first bun subcommand resolves packages and accepts `--registry`. */
export function bunUsesRegistry(args: readonly string[]): boolean {
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  return subcommand !== undefined && REGISTRY_SUBCOMMANDS.has(subcommand);
}

/**
 * `process.env` plus the runtime executable directory and registry aliases.
 *
 * The executable directory matters when this CLI was launched by absolute path:
 * bun runs, but a lifecycle script that invokes `bun`/`node` by bare name would
 * otherwise fail with `command not found`. Prepending `dirname(process.execPath)`
 * (the running bun binary's dir) puts the runtime back on PATH.
 */
export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const runtimeBin = dirname(process.execPath);
  const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (!pathEntries.includes(runtimeBin)) {
    env.PATH = [runtimeBin, ...pathEntries].join(delimiter);
  }
  const url = registryOverride();
  if (url) {
    // Both cases: env is case-sensitive on POSIX, and npm lowercases when reading.
    env.npm_config_registry = url;
    env.NPM_CONFIG_REGISTRY = url;
  }
  return env;
}

/**
 * Resolve the argv prefix to run bun: the `bun` package's own bin when this CLI
 * is itself running under bun (`process.execPath` is the bun binary), else a bare
 * `bun` on PATH. No corepack/npx fallback - bun is the ambient runtime this
 * toolchain requires.
 */
function resolveBunArgvImpl(): string[] {
  // The running process IS bun in every supported path (the bin is `bun <file>`),
  // so reuse it directly - no PATH lookup, no package-manager shim.
  if (/\bbun\b/.test(process.execPath)) return [process.execPath];
  return ["bun"];
}

/** Memoized `[command, ...prefix]` argv prefix to run bun. */
export const resolveBunArgv = functionModule.memoize(resolveBunArgvImpl);

/** Run bun with inherited stdio from `cwd`, forcing the resolved registry. */
export function runBun(args: string[], cwd: string): void {
  const [command, ...prefix] = resolveBunArgv();
  const registryArgs = bunRegistryArgs(args);
  if (registryArgs.length > 0) {
    logger.info(`running bun with registry: ${registryArgs[1]}`);
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
    runBun(["install"], root);
  }
}

/**
 * Run projen with the given args from `root`. Prefers the installed `projen` bin
 * via `bun run`, so the workspace's own engine + tasks are used.
 */
export function runProjen(args: string[], root: string): void {
  const projenBin = join(root, "node_modules", ".bin", "projen");
  if (existsSync(projenBin)) {
    runBun([projenBin, ...args], root);
    return;
  }
  // Fallback: resolve projen through bun's package runner.
  runBun(["x", "projen", ...args], root);
}
