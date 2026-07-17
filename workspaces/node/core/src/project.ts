import { spawnSync } from "node:child_process";
import { Stats, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const ROOT_MARKERS = [
  ".projenrc.ts",
  ".projenrc.js",
  ".projenrc.mjs",
  ".projenrc.cjs",
  "package.json",
] as const;

function statPath(path: string): Stats | undefined {
  if (path) {
    try {
      return statSync(path);
    } catch {}
  }
  return undefined;
}

/**
 * because this is crucial do not use exec.spawnSync
 */
function directoryCommand(command: string, args: string[], cwd: string): string | undefined {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
  if (result.status === 0) {
    const output = result.stdout.toString().trim();
    return statPath(output)?.isDirectory() ? output : undefined;
  }
  return undefined;
}

const rootDirectoryCommands: Record<string, [string, string[]]> = {
  npm: ["npm", ["prefix"]] as const,
  git: ["git", ["rev-parse", "--show-toplevel"]] as const,
} as const;

const rootDirectoryDefaultCache = new Map<
  keyof typeof rootDirectoryCommands,
  { cwd: string; path?: string }
>();

function rootDirectory(name: keyof typeof rootDirectoryCommands, cwd?: string): string | undefined {
  const [command, args] = rootDirectoryCommands[name];
  let cache: boolean;
  if (cwd === undefined) {
    cwd = process.cwd();
    cache = true;
  } else {
    cache = cwd === process.cwd();
  }
  if (cache) {
    const cached = rootDirectoryDefaultCache.get(name);
    if (cached?.cwd === cwd) {
      return cached!.path;
    }
  }
  const path = directoryCommand(command, args, cwd);
  if (cache) {
    rootDirectoryDefaultCache.set(name, { cwd, path });
  }
  return path;
}
function npmRoot(cwd?: string): string | undefined {
  return rootDirectory("npm", cwd);
}

function gitRoot(cwd?: string): string | undefined {
  return rootDirectory("git", cwd);
}

export function root(cwd: string = process.cwd()): string | undefined {
  let current = resolve(cwd);

  if (!statPath(current)?.isDirectory()) {
    current = dirname(current);
  }
  const boundaries = new Set(
    [npmRoot(cwd), gitRoot(cwd)]
      .filter((path): path is string => path !== undefined)
      .map((path) => resolve(path)),
  );
  const hasBoundary = boundaries.size > 0;
  let best: { dir: string; priority: number } | undefined;
  while (true) {
    for (const [priority, marker] of ROOT_MARKERS.entries()) {
      if (statPath(join(current, marker))?.isFile()) {
        if (
          best === undefined ||
          priority < best.priority ||
          (priority === best.priority && current.length < best.dir.length)
        ) {
          best = { dir: current, priority };
        }
        break;
      }
    }
    if (!hasBoundary && best) {
      return best.dir;
    }
    if (boundaries.has(current)) {
      return best?.dir;
    }
    const parent = dirname(current);
    if (parent === current) {
      return best?.dir;
    }
    current = parent;
  }
}

/** Best-effort `fs.stat` (sync). Returns `undefined` when `path` can't be stat'd. */
export function stat(path: string): Stats | undefined {
  return statPath(path);
}

/**
 * Parse a git remote URL (`https://...`, `git@host:owner/repo.git`, etc.) and
 * return the repo segment, stripping any `.git` suffix. Returns `undefined` for
 * empty or unparsable input.
 */
export function parseGitRemote(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;

  const scp = /^[^@]+@[^:]+:(.+)$/i.exec(trimmed);
  if (scp) return lastPathSegment(scp[1] ?? "");

  try {
    const normalized = trimmed.replace(/\.git$/i, "");
    const pathname = new URL(normalized).pathname;
    const segment = pathname.split("/").filter(Boolean).at(-1);
    return segment ? lastPathSegment(segment) : undefined;
  } catch {
    return undefined;
  }
}

function lastPathSegment(path: string): string {
  const segment = path.split("/").filter(Boolean).at(-1) ?? path;
  return segment.replace(/\.git$/i, "");
}

/**
 * Yield candidate project-root directories for `cwd`, in priority order: the
 * `npm prefix`, the git top-level, then `cwd` itself. Duplicates are skipped;
 * only existing directories are yielded (except the final `cwd` fallback).
 */
export function* resolveProjectRoots(cwd: string = process.cwd()): Generator<string> {
  const base = resolve(cwd);
  const seen = new Set<string>();
  for (const candidate of [npmRoot(base), gitRoot(base)]) {
    if (!candidate) continue;
    const dir = resolve(candidate);
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (statPath(dir)?.isDirectory()) yield dir;
  }
  if (!seen.has(base)) yield base;
}

/** The nearest ancestor of `cwd` (from {@link resolveProjectRoots}) with a `package.json`. */
function workspaceRoot(cwd: string = process.cwd()): string {
  let last: string | undefined;
  for (const dir of resolveProjectRoots(cwd)) {
    if (statPath(resolve(dir, "package.json"))?.isFile()) return dir;
    last = dir;
  }
  return last ?? resolve(cwd);
}

/**
 * Resolve a human-friendly project name for the repo rooted at `cwd`:
 * `package.json` `name`, then the git remote's repo name, then the root
 * directory's basename.
 */
export function name(cwd: string = process.cwd()): string {
  const rootDir = workspaceRoot(cwd);

  const fromPackage = readPackageName(resolve(rootDir, "package.json"));
  if (fromPackage) return fromPackage;

  const remote = commandOutput("git", ["-C", rootDir, "remote", "get-url", "origin"], rootDir);
  const fromGit = remote ? parseGitRemote(remote) : undefined;
  if (fromGit) return fromGit;

  return basename(rootDir);
}

/** Trimmed stdout of a command, or `undefined` when it fails or prints nothing. */
function commandOutput(command: string, args: string[], cwd: string): string | undefined {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) return undefined;
  return result.stdout.toString().trim() || undefined;
}

function readPackageName(pkgPath: string): string | undefined {
  if (!statPath(pkgPath)?.isFile()) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
    return pkg.name?.trim() || undefined;
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  console.log("npm root:", npmRoot());
  console.log("repo root:", gitRoot());
  console.log("package root:", root());
  console.log("project name:", name());
}
