import { spawnSync } from "node:child_process";
import { Stats, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { json, net, object, stringUtils } from "@dbx-tools/shared-core";
import { parse as parseYaml } from "yaml";
import { cachedRecord, statSync as fileStatSync } from "./file.ts";

const ROOT_MARKERS = [
  ".projenrc.ts",
  ".projenrc.js",
  ".projenrc.mjs",
  ".projenrc.cjs",
  "package.json",
] as const;

/** Resolve a blank, null, omitted, relative, or absolute cwd to an absolute path. */
export function resolveWorkingDirectory(cwd?: string | null): string {
  return resolve(stringUtils.trimToNull(cwd) ?? process.cwd());
}

/** A command's stdout, classified as a filesystem path and/or a URL. */
export interface ProjectContext {
  readonly output: string;
  /** `output` when it names something on disk. */
  readonly path?: string;
  /** `file.statSync` of {@link path}, when it exists. */
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
  const output = result?.stdout?.toString()?.trim();
  if (result.status === 0 && output) {
    const pathStats = fileStatSync(output);
    // Only an EXPLICIT `scheme://...` counts as a URL. `urlBuilder` otherwise
    // synthesizes one (a bare `example.com` -> `https://…`, an absolute path ->
    // `http://localhost/…`), which would mislabel directory outputs and bare
    // tokens - so gate on the raw output already carrying a scheme + authority.
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(output) ? net.urlBuilder(output) : undefined;
    return { output, path: pathStats ? output : undefined, pathStats, url };
  }
  return { output };
}

const projectCommandCache = new Map<string, ProjectContext>();

function projectContextCommand(command: string, args: string[], cwd?: string): ProjectContext {
  const resolved = resolveWorkingDirectory(cwd);
  const key =
    resolved === resolveWorkingDirectory() ? JSON.stringify([command, ...args]) : undefined;
  if (key !== undefined) {
    const cached = projectCommandCache.get(key);
    if (cached !== undefined) return cached;
  }
  const value = projectContextCommandOutput(command, args, resolved);
  if (key !== undefined) projectCommandCache.set(key, value);
  return value;
}

function commandRoot(command: string, args: string[], cwd: string): string | undefined {
  const parsed = projectContextCommand(command, args, cwd);
  return parsed.pathStats?.isDirectory() ? parsed.path : undefined;
}

/**
 * Closest directory with a `package.json` or `node_modules`, matching `npm prefix`.
 *
 * Lifecycle scripts from npm and Bun set `npm_config_local_prefix` to that
 * directory. Read it first when resolving this process's cwd so a missing npm
 * CLI is not required. `npm_config_prefix` / `PREFIX` are the global install
 * prefix and must not be used here.
 *
 * Bun has no prefix command (`bun pm bin` is the `.bin` directory). pnpm's
 * `prefix` command is unimplemented; `pnpm root` prints `node_modules`.
 */
function npmRoot(cwd?: string): string | undefined {
  const resolved = resolveWorkingDirectory(cwd);
  if (resolved === resolveWorkingDirectory()) {
    const fromEnv = envDirectory(process.env.npm_config_local_prefix);
    if (fromEnv) return fromEnv;
  }
  return commandRoot("npm", ["prefix"], resolved);
}

function envDirectory(value: string | undefined): string | undefined {
  const path = stringUtils.trimToNull(value);
  if (!path) return undefined;
  const resolved = resolve(path);
  return fileStatSync(resolved)?.isDirectory() ? resolved : undefined;
}

function gitRoot(cwd?: string): string | undefined {
  const resolved = resolveWorkingDirectory(cwd);
  return commandRoot("git", ["rev-parse", "--show-toplevel"], resolved);
}

/** Resolve the nearest project root without walking above its npm or Git boundary. */
export function root(cwd?: string): string | undefined {
  const resolved = resolveWorkingDirectory(cwd);
  let current = resolved;

  if (!fileStatSync(current)?.isDirectory()) {
    current = dirname(current);
  }
  const boundaries = new Set(
    [npmRoot(resolved), gitRoot(resolved)]
      .filter((path): path is string => path !== undefined)
      .map((path) => resolve(path)),
  );
  const hasBoundary = boundaries.size > 0;
  let best: { dir: string; priority: number } | undefined;
  while (true) {
    for (const [priority, marker] of ROOT_MARKERS.entries()) {
      if (fileStatSync(join(current, marker))?.isFile()) {
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
export function* resolveProjectRoots(cwd?: string): Generator<string> {
  const base = resolveWorkingDirectory(cwd);
  const seen = new Set<string>();
  for (const candidate of [npmRoot(base), gitRoot(base)]) {
    if (!candidate) continue;
    const dir = resolve(candidate);
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (fileStatSync(dir)?.isDirectory()) yield dir;
  }
  if (!seen.has(base)) yield base;
}

/** The nearest ancestor of `cwd` (from {@link resolveProjectRoots}) with a `package.json`. */
function workspaceRoot(cwd?: string): string {
  let last: string | undefined;
  for (const dir of resolveProjectRoots(cwd)) {
    if (fileStatSync(resolve(dir, "package.json"))?.isFile()) return dir;
    last = dir;
  }
  return last ?? resolveWorkingDirectory(cwd);
}

/**
 * Resolve a human-friendly project name for the repo rooted at `cwd`:
 * `package.json` `name`, then the git remote's repo name, then the root
 * directory's basename.
 */
export function name(cwd?: string): string {
  const resolved = resolveWorkingDirectory(cwd);
  const rootDir = workspaceRoot(resolved);

  const fromPackage = readPackageName(resolve(rootDir, "package.json"));
  if (fromPackage) return fromPackage;

  const remote = projectContextCommand(
    "git",
    ["-C", rootDir, "remote", "get-url", "origin"],
    rootDir,
  ).output;
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
  return stringUtils.trimToNull(json.parseRecord(out)?.url) ?? undefined;
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
 * `git remote get-url origin`. A blank, omitted, or explicitly current `cwd`
 * reuses cached command probes; another resolved directory executes directly.
 *
 * @param cwd - directory to resolve from (defaults to `process.cwd()`).
 * @param format - `"https"` (default) yields `https://host/owner/repo`;
 *   `"npm"` yields npm's `git+https://host/owner/repo.git` form (for a
 *   `package.json` `repository.url` that passes npm provenance).
 */
export function repositoryUrl(cwd?: string, format: "https" | "npm" = "https"): string | undefined {
  const resolved = resolveWorkingDirectory(cwd);
  const https = repositoryUrlFromGh(resolved) ?? repositoryUrlFromGit(resolved);
  if (!https) return undefined;
  return format === "npm" ? `git+${https.replace(/\.git$/, "")}.git` : https;
}

/** Public npm, used only after env, npmrc, bunfig, and pnpm yaml miss. */
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";

/** Inputs that control active npm registry discovery. */
export type NpmRegistryOptions = {
  /** Skip public npmjs.org so callers can detect a configured override. */
  overrideOnly?: boolean;
  /**
   * Read `npm_config_registry`, `NPM_CONFIG_REGISTRY`, and `BUN_CONFIG_REGISTRY`
   * first. Defaults to true so the same cascade a package manager uses is the
   * default.
   */
  envVars?: boolean;
};

const npmRegistryCache = new Map<string, net.UrlBuilder | undefined>();

/**
 * The active npm registry as a chainable {@link net.UrlBuilder}.
 *
 * Resolution is manager-agnostic and memoized per cwd plus options: environment
 * variables, then `.npmrc` (project ancestors, user, global), then Bun
 * `bunfig.toml` `install.registry`, then pnpm workspace/global YAML, then
 * `https://registry.npmjs.org/`. `overrideOnly` skips that public default.
 */
export function npmRegistry(
  cwd?: string | null,
  options?: NpmRegistryOptions,
): net.UrlBuilder | undefined {
  const resolved = resolveWorkingDirectory(cwd);
  const envVars = options?.envVars !== false;
  const overrideOnly = Boolean(options?.overrideOnly);
  const key = JSON.stringify([
    resolved,
    overrideOnly,
    envVars,
    homedir(),
    process.env.NPM_CONFIG_USERCONFIG ?? "",
    process.env.NPM_CONFIG_GLOBALCONFIG ?? "",
    process.env.PREFIX ?? "",
    envVars ? (process.env.npm_config_registry ?? "") : "",
    envVars ? (process.env.NPM_CONFIG_REGISTRY ?? "") : "",
    envVars ? (process.env.BUN_CONFIG_REGISTRY ?? "") : "",
  ]);
  if (npmRegistryCache.has(key)) return npmRegistryCache.get(key);
  const value = resolveNpmRegistry(resolved, { overrideOnly, envVars });
  npmRegistryCache.set(key, value);
  return value;
}

function resolveNpmRegistry(
  cwd: string,
  options: { overrideOnly: boolean; envVars: boolean },
): net.UrlBuilder | undefined {
  for (const candidate of npmRegistryCandidates(cwd, options.envVars)) {
    const url = toRegistryUrl(candidate, options.overrideOnly);
    if (url) return url;
  }
  return toRegistryUrl(DEFAULT_NPM_REGISTRY, options.overrideOnly);
}

function* npmRegistryCandidates(cwd: string, envVars: boolean): Generator<string | undefined> {
  if (envVars) {
    yield process.env.npm_config_registry;
    yield process.env.NPM_CONFIG_REGISTRY;
    yield process.env.BUN_CONFIG_REGISTRY;
  }
  for (const dir of ancestorDirs(cwd)) {
    yield readNpmrcRegistry(join(dir, ".npmrc"));
  }
  yield readNpmrcRegistry(process.env.NPM_CONFIG_USERCONFIG ?? join(homedir(), ".npmrc"));
  yield readNpmrcRegistry(process.env.NPM_CONFIG_GLOBALCONFIG ?? defaultGlobalNpmrc());
  for (const dir of ancestorDirs(cwd)) {
    yield readBunfigRegistry(join(dir, "bunfig.toml"));
  }
  yield readBunfigRegistry(join(homedir(), "bunfig.toml"));
  for (const dir of ancestorDirs(cwd)) {
    yield readYamlRegistry(join(dir, "pnpm-workspace.yaml"));
  }
  for (const path of pnpmGlobalConfigPaths()) {
    yield readYamlRegistry(path);
  }
}

function toRegistryUrl(
  candidate: string | undefined,
  overrideOnly: boolean,
): net.UrlBuilder | undefined {
  const trimmed = stringUtils.trimToNull(candidate);
  if (!trimmed) return undefined;
  const url = net.urlBuilder(trimmed);
  if (!url) return undefined;
  if (overrideOnly && isPublicNpmRegistry(url)) return undefined;
  return url;
}

function isPublicNpmRegistry(url: net.UrlBuilder): boolean {
  return url.hostname === "registry.npmjs.org";
}

function* ancestorDirs(cwd: string): Generator<string> {
  let current = cwd;
  while (true) {
    yield current;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function defaultGlobalNpmrc(): string {
  if (process.platform === "win32") {
    return join(process.env.PROGRAMDATA ?? "C:\\ProgramData", "npm", "etc", "npmrc");
  }
  return join(process.env.PREFIX ?? "/usr/local", "etc", "npmrc");
}

function pnpmGlobalConfigPaths(): string[] {
  const home = homedir();
  if (process.platform === "darwin") {
    return [join(home, "Library/Preferences/pnpm/config.yaml")];
  }
  if (process.platform === "win32") {
    return [join(process.env.LOCALAPPDATA ?? join(home, "AppData/Local"), "pnpm/config.yaml")];
  }
  return [join(home, ".config/pnpm/config.yaml")];
}

function readNpmrcRegistry(path: string): string | undefined {
  return cachedRecord(`npmrc-registry:${path}`, () => {
    const text = readTextFile(path);
    const registry = text ? parseIniRegistry(text) : undefined;
    return registry ? { registry } : undefined;
  })?.registry;
}

function readBunfigRegistry(path: string): string | undefined {
  return cachedRecord(`bunfig-registry:${path}`, () => {
    const text = readTextFile(path);
    const registry = text ? parseBunfigRegistry(text) : undefined;
    return registry ? { registry } : undefined;
  })?.registry;
}

function readYamlRegistry(path: string): string | undefined {
  return cachedRecord(`yaml-registry:${path}`, () => {
    const text = readTextFile(path);
    if (!text) return undefined;
    const parsed = parseYaml(text);
    if (!object.isRecord(parsed)) return undefined;
    const registry = yamlRegistry(parsed);
    return registry ? { registry } : undefined;
  })?.registry;
}

function readTextFile(path: string): string | undefined {
  if (!fileStatSync(path)?.isFile()) return undefined;
  return readFileSync(path, "utf8");
}

/** Parse a `registry=` assignment from npmrc / ini text. */
function parseIniRegistry(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== "registry") continue;
    return unquoteIniValue(line.slice(eq + 1));
  }
  return undefined;
}

/**
 * Read Bun `install.registry` from a bunfig.toml. Table form
 * `[install.registry]` with `url = "..."` is accepted; scoped maps are ignored.
 */
function parseBunfigRegistry(text: string): string | undefined {
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = unquoteIniValue(line.slice(eq + 1));
    if (section === "install" && key === "registry" && !value.startsWith("{")) return value;
    if (section === "install.registry" && key === "url") return value;
    if (!section && key === "install.registry") return value;
  }
  return undefined;
}

function yamlRegistry(data: Record<string, unknown>): string | undefined {
  if (typeof data.registry === "string") return data.registry;
  const registries = data.registries;
  if (object.isRecord(registries) && typeof registries.default === "string") {
    return registries.default;
  }
  return undefined;
}

function unquoteIniValue(value: string): string {
  const trimmed = value.trim();
  const comment = trimmed.search(/\s+#/);
  const raw = comment === -1 ? trimmed : trimmed.slice(0, comment).trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function stripTomlComment(line: string): string {
  const hash = line.indexOf("#");
  return hash === -1 ? line : line.slice(0, hash);
}

function readPackageName(pkgPath: string): string | undefined {
  if (!fileStatSync(pkgPath)?.isFile()) return undefined;
  return stringUtils.trimToNull(json.parseRecord(readFileSync(pkgPath, "utf8"))?.name) ?? undefined;
}

if (import.meta.main) {
  console.log("npm root:", npmRoot());
  console.log("repo root:", gitRoot());
  console.log("package root:", root());
  console.log("project name:", name());
  console.log("repository url:", repositoryUrl());
  console.log("repository url (npm):", repositoryUrl(undefined, "npm"));
}
