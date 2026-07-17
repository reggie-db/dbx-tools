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

/** Per-cwd cache for {@link repositoryUrl} (mirrors {@link rootDirectoryDefaultCache}). */
const repositoryUrlCache = new Map<string, { cwd: string; url?: string }>();

/**
 * Ask the GitHub CLI for the canonical repo URL - the easy path. `gh` already
 * resolves the true host (no ssh-alias parsing) and prints a clean
 * `https://github.com/owner/repo`. `undefined` when `gh` is absent, not
 * authenticated, or the dir isn't a GitHub repo.
 */
function repositoryUrlFromGh(cwd: string): string | undefined {
  const out = commandOutput("gh", ["repo", "view", "--json", "url"], cwd);
  if (!out) return undefined;
  try {
    return (JSON.parse(out) as { url?: string }).url?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve an ssh host alias (`~/.ssh/config`) to its effective `hostname` via `ssh -G`. */
function resolveSshHostName(host: string, cwd: string): string | undefined {
  const line = commandOutput("ssh", ["-G", host], cwd)
    ?.split("\n")
    .find((l) => /^hostname\s/i.test(l.trim()));
  const name = line?.trim().split(/\s+/)[1];
  return name && name !== host ? name : undefined;
}

/**
 * Fallback: normalize `git remote get-url origin` to a plain
 * `https://host/owner/repo` URL. scp-like / `ssh://` / `git://` /
 * embedded-credential forms are rewritten to https, and an ssh host alias is
 * followed to its real hostname.
 */
function repositoryUrlFromGit(cwd: string): string | undefined {
  const raw = commandOutput("git", ["remote", "get-url", "origin"], cwd);
  if (!raw) return undefined;

  let url = raw.replace(/^git\+/, "");
  // scp-like `git@host:owner/repo` -> `https://host/owner/repo`.
  const scp = /^[^@]+@([^:]+):(.+)$/.exec(url);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  // `ssh://user@host/...` / `git://host/...` -> `https://host/...`, then drop any
  // embedded `user[:pass]@` credentials and the trailing `.git`.
  url = url
    .replace(/^ssh:\/\/[^@/]+@/, "https://")
    .replace(/^(ssh|git):\/\//, "https://")
    .replace(/^(https?:\/\/)[^@/]+@/, "$1")
    .replace(/\.git$/, "");
  // Follow an ssh host alias to the true host (so `github-reggie-db` -> `github.com`).
  const parts = /^(https?:\/\/)([^/]+)(\/.*)$/.exec(url);
  if (parts) {
    const realHost = resolveSshHostName(parts[2]!, cwd);
    if (realHost) url = `${parts[1]}${realHost}${parts[3]}`;
  }
  return url;
}

/**
 * The repo's canonical remote URL, or `undefined` when there is no git remote.
 * Tries `gh repo view` first (host-accurate, no parsing), then normalizes
 * `git remote get-url origin`. Result is cached per `cwd`.
 *
 * @param cwd - directory to resolve from (defaults to `process.cwd()`).
 * @param format - `"https"` (default) yields `https://host/owner/repo`;
 *   `"npm"` yields npm's `git+https://host/owner/repo.git` form (for a
 *   `package.json` `repository.url` that passes npm provenance).
 */
export function repositoryUrl(
  cwd: string = process.cwd(),
  format: "https" | "npm" = "https",
): string | undefined {
  const cached = repositoryUrlCache.get(cwd);
  let https: string | undefined;
  if (cached && cached.cwd === cwd) {
    https = cached.url;
  } else {
    https = repositoryUrlFromGh(cwd) ?? repositoryUrlFromGit(cwd);
    repositoryUrlCache.set(cwd, { cwd, url: https });
  }
  if (!https) return undefined;
  return format === "npm" ? `git+${https.replace(/\.git$/, "")}.git` : https;
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
  console.log("repository url:", repositoryUrl());
  console.log("repository url (npm):", repositoryUrl(process.cwd(), "npm"));
}
