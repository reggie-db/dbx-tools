import { spawnSync } from "node:child_process";
import { Stats } from "node:fs";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { hash, net } from "@dbx-tools/shared-core";
import { statSync as stat } from "./file";


const ROOT_MARKERS = [
  ".projenrc.ts",
  ".projenrc.js",
  ".projenrc.mjs",
  ".projenrc.cjs",
  "package.json",
] as const;

/** A command's stdout, classified as a filesystem path and/or a URL. */
export interface ProjectContext {
  readonly cwd: string;
  readonly output: string
  /** `output` when it names something on disk. */
  readonly path?: string;
  /** `fs.stat` of {@link path}, when it exists. */
  readonly pathStats?: Stats;
  /**
   * `output` parsed into a chainable {@link net.UrlBuilder}, when it is a real
   * network URL - a non-blank scheme (not `file:`) AND a non-blank hostname.
   * Bare paths, scp-like `git@host:...` remotes, and `file:` URLs stay unset.
   */
  readonly url?: net.UrlBuilder;
}


/**
 * because this is crucial do not use exec.spawnSync
 *
 * Run `command args` in `cwd` and classify its stdout: `path` + `pathStats` when
 * the output names something on disk, `url` (a {@link net.UrlBuilder}) when it
 * parses as a real network URL. Empty {@link ProjectContext} on a non-zero exit
 * or empty output.
 */
function projectContextCommandOutput(command: string, args: string[], cwd: string): ProjectContext {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
  const output = result.stdout.toString().trim();
  if (result.status === 0 && output) {
    const pathStats = stat(output);
    // Only an EXPLICIT `scheme://...` counts as a URL. `urlBuilder` otherwise
    // synthesizes one (a bare `example.com` -> `https://…`, an absolute path ->
    // `http://localhost/…`), which would mislabel directory outputs and bare
    // tokens - so gate on the raw output already carrying a scheme + authority.
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(output) ? net.urlBuilder(output) : undefined;
    return { cwd, output, path: pathStats ? output : undefined, pathStats, url };
  }
  return { cwd, output };
}

/**
 * `parseCommand`, memoized per `(command, args, cwd)` - stores the whole
 * {@link ProjectContext}. The cache key is a stable {@link hash.fnvHash} of that
 * tuple (order-sensitive over `args`), so `cwd` is part of the key and a lookup
 * in another directory can't collide with the default-cwd entry.
 */
const parsedCommandCache = new Map<string, ProjectContext>();

function projectContextCommand(command: string, args: string[], cwd?: string): ProjectContext {
  const processCwd = resolve(process.cwd());
  let cacheEnabled: boolean
  if (!cwd) {
    cwd = processCwd;
    cacheEnabled = true;
  } else {
    cwd = resolve(cwd);
    if (cwd == processCwd) {
      cacheEnabled = true;
    } else {
      cacheEnabled = false;
    }
  }
  const cacheKey = cacheEnabled ? hash.fnvHash(command, args) : undefined;
  const cacheHit = cacheKey ? parsedCommandCache.get(cacheKey) : undefined;
  if (cacheHit?.cwd === cwd) { return cacheHit; }
  const result = projectContextCommandOutput(command, args, cwd);
  if (cacheKey) {
    parsedCommandCache.set(cacheKey, result);
  }
  return result;
}

function npmRoot(cwd?: string): string | undefined {
  const parsed = projectContextCommand("npm", ["prefix"], cwd);
  return parsed.pathStats?.isDirectory() ? parsed.path : undefined;
}

function gitRoot(cwd?: string): string | undefined {
  const parsed = projectContextCommand("git", ["rev-parse", "--show-toplevel"], cwd);
  return parsed.pathStats?.isDirectory() ? parsed.path : undefined;
}

export function root(cwd: string = process.cwd()): string | undefined {
  let current = resolve(cwd);

  if (!stat(current)?.isDirectory()) {
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
      if (stat(join(current, marker))?.isFile()) {
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
    if (stat(dir)?.isDirectory()) yield dir;
  }
  if (!seen.has(base)) yield base;
}

/** The nearest ancestor of `cwd` (from {@link resolveProjectRoots}) with a `package.json`. */
function workspaceRoot(cwd: string = process.cwd()): string {
  let last: string | undefined;
  for (const dir of resolveProjectRoots(cwd)) {
    if (stat(resolve(dir, "package.json"))?.isFile()) return dir;
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

  const remote = projectContextCommand("git", ["-C", rootDir, "remote", "get-url", "origin"], rootDir).output;
  const fromGit = remote ? parseGitRemote(remote) : undefined;
  if (fromGit) return fromGit;

  return basename(rootDir);
}

/**
 * The GitHub CLI's canonical repo URL - the easy path. `gh` already resolves the
 * true host (no ssh-alias parsing) and prints a clean `https://host/owner/repo`.
 * `undefined` when `gh` is absent, unauthenticated, or the dir isn't a GH repo.
 */
function repositoryUrlFromGh(cwd?: string): string | undefined {
  const out = projectContextCommand("gh", ["repo", "view", "--json", "url"], cwd).output;
  if (!out) return undefined;
  try {
    return (JSON.parse(out) as { url?: string }).url?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve an ssh host alias (`~/.ssh/config`) to its effective `hostname` via `ssh -G`. */
function resolveSshHostName(host: string, cwd?: string): string | undefined {
  const line = projectContextCommand("ssh", ["-G", host], cwd)
    .output?.split("\n")
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
function repositoryUrlFromGit(cwd?: string): string | undefined {
  const raw = projectContextCommand("git", ["remote", "get-url", "origin"], cwd).output;
  if (!raw) return undefined;

  // Normalize the scheme to https at the string level first: the WHATWG `URL`
  // parser can't convert a non-special scheme (`ssh`/`git`) to `https` (the
  // `protocol` setter no-ops), and scp-like `git@host:owner/repo` isn't a URL at
  // all. Rewrite both into an `https://` string, then let {@link net.urlBuilder}
  // own the structured edits (strip credentials, swap the host).
  let https = raw.replace(/^git\+/, "");
  const scp = /^[^@]+@([^:]+):(.+)$/.exec(https);
  if (scp) https = `https://${scp[1]}/${scp[2]}`;
  https = https.replace(/^(ssh|git):\/\//, "https://");

  let builder = net.urlBuilder(https);
  if (!builder) return undefined;
  // Drop any embedded `user[:pass]@` credentials.
  if (builder.username || builder.password) {
    builder = builder.with("username", "").with("password", "");
  }
  // Follow an ssh host alias to the true host (so `github-reggie-db` -> `github.com`).
  const realHost = resolveSshHostName(builder.hostname, cwd);
  if (realHost) builder = builder.with("hostname", realHost);

  return `${builder.origin}${builder.pathname.replace(/\.git$/, "")}`;
}

/**
 * The repo's canonical remote URL, or `undefined` when there is no git remote.
 * Tries `gh repo view` first (host-accurate, no parsing), then normalizes
 * `git remote get-url origin`. Both underlying commands are cached per `cwd` via
 * {@link projectContextCommand}.
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
  const https = repositoryUrlFromGh(cwd) ?? repositoryUrlFromGit(cwd);
  if (!https) return undefined;
  return format === "npm" ? `git+${https.replace(/\.git$/, "")}.git` : https;
}

function readPackageName(pkgPath: string): string | undefined {
  if (!stat(pkgPath)?.isFile()) return undefined;
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
