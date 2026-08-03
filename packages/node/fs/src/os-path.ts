/**
 * Resolve durable local home and temp directories for Node hosts.
 *
 * Home order (mkdir + write/delete probe; failure skips):
 * 1. `os.homedir()`
 * 2. `HOME` / `USERPROFILE`
 * 3. `/home/app` when {@link envUtil.isAppEnv}
 * 4. `./.home` under cwd
 *
 * Temp order (same ensure/probe/skip):
 * 1. `os.tmpdir()`
 * 2. `TMPDIR` / `TMP` / `TEMP`
 * 3. `.tmp` under the resolved home
 *
 * Both paths are memoized per resolved cwd (same idea as
 * `@dbx-tools/core` `project` command caching): cwd is part of the key because
 * the `./.home` / `<home>/.tmp` fallbacks depend on it.
 *
 * @module
 */

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { env as envUtil } from "@dbx-tools/shared-core";

/** Databricks Apps container home when {@link envUtil.isAppEnv}. */
export const APP_HOME = "/home/app";

/** Resolved home + temp for one cwd. */
export interface OsPaths {
  readonly home: string;
  readonly tmp: string;
}

/** Injectable knobs for {@link resolveOsPaths} (mostly tests). */
export interface ResolveOsPathsOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Defaults to `os.homedir`. */
  homeDir?: () => string;
  /** Defaults to `os.tmpdir`. */
  tmpDir?: () => string;
  /** App-env candidate; defaults to {@link APP_HOME}. */
  appHome?: string;
}

/** Memoized {@link OsPaths} keyed by resolved cwd. */
const osPathsCache = new Map<string, OsPaths>();

/**
 * Resolve home + temp for {@link cwd}, memoized when {@link cwd} is the process
 * cwd (an explicit other cwd is computed fresh, matching core `project`
 * caching).
 */
export function resolveOsPaths(options: ResolveOsPathsOptions = {}): OsPaths {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const cacheEnabled = cwd === path.resolve(process.cwd());
  if (cacheEnabled) {
    const hit = osPathsCache.get(cwd);
    if (hit) return hit;
  }

  const env = options.env ?? process.env;
  const home = resolveHome(env, cwd, options);
  const tmp = resolveTemp(env, home, options);
  const resolved: OsPaths = { home, tmp };

  if (cacheEnabled) osPathsCache.set(cwd, resolved);
  return resolved;
}

/** {@link resolveOsPaths}.home */
export function resolveLocalHome(options: ResolveOsPathsOptions = {}): string {
  return resolveOsPaths(options).home;
}

/** {@link resolveOsPaths}.tmp */
export function resolveLocalTemp(options: ResolveOsPathsOptions = {}): string {
  return resolveOsPaths(options).tmp;
}

/** Drop memoized entries (tests). */
export function clearOsPathsCache(): void {
  osPathsCache.clear();
}

function resolveHome(env: NodeJS.ProcessEnv, cwd: string, options: ResolveOsPathsOptions): string {
  const tried = new Set<string>();
  const candidates: Array<string | undefined> = [
    tryCall(options.homeDir ?? homedir),
    env.HOME?.trim(),
    env.USERPROFILE?.trim(),
    envUtil.isAppEnv(env) ? (options.appHome ?? APP_HOME) : undefined,
  ];

  for (const candidate of candidates) {
    if (!candidate || tried.has(candidate)) continue;
    tried.add(candidate);
    if (isUsableDir(candidate)) return candidate;
  }

  const fallback = path.resolve(cwd, ".home");
  if (!isUsableDir(fallback)) {
    throw new Error(`Unable to create a writable home directory at ${fallback}`);
  }
  return fallback;
}

function resolveTemp(env: NodeJS.ProcessEnv, home: string, options: ResolveOsPathsOptions): string {
  const tried = new Set<string>();
  // os.tmpdir first, then the standard override env vars (Node checks
  // TMPDIR/TMP/TEMP on POSIX and TEMP/TMP on Windows inside tmpdir itself;
  // listing them again lets a failed create/write fall through to the next).
  const candidates: Array<string | undefined> = [
    tryCall(options.tmpDir ?? tmpdir),
    env.TMPDIR?.trim(),
    env.TMP?.trim(),
    env.TEMP?.trim(),
  ];

  for (const candidate of candidates) {
    if (!candidate || tried.has(candidate)) continue;
    tried.add(candidate);
    if (isUsableDir(candidate)) return candidate;
  }

  const fallback = path.join(home, ".tmp");
  if (!isUsableDir(fallback)) {
    throw new Error(`Unable to create a writable temp directory at ${fallback}`);
  }
  return fallback;
}

function tryCall(fn: () => string): string | undefined {
  try {
    return fn().trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when {@link dir} can be created (if missing) and a probe file can be
 * written then deleted. Read-only or otherwise unusable dirs return false.
 */
function isUsableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return false;
  }

  const probe = path.join(dir, `.dbx-os-path-probe-${process.pid}-${process.hrtime.bigint()}`);
  try {
    writeFileSync(probe, "");
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // Probe cleanup is best-effort; usability already decided by the write.
    }
  }
}
