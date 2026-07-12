/**
 * Shared filesystem helpers for the watcher/updater scripts: where the repo is,
 * how to enumerate `packages/<scope>/<name>` packages and their `src` roots, and
 * the "is this a module file / does it export anything" predicates the barrel
 * and scaffold logic share.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";

/** Run a command, returning trimmed stdout, or undefined on any failure. */
function tryCmd(cmd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The repo root, detected (in order): `npm prefix` (nearest package root), then
 * the git top-level, then the current working directory.
 */
export const repoRoot =
  tryCmd("npm", ["prefix"]) ??
  tryCmd("git", ["rev-parse", "--show-toplevel"]) ??
  process.cwd();
export const PACKAGES_DIR = join(repoRoot, "packages");

/** A project name: the git remote's repo name, else the root folder name. */
export function projectName(): string {
  const url = tryCmd("git", ["-C", repoRoot, "config", "--get", "remote.origin.url"]);
  const fromGit = url?.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop();
  return fromGit ?? basename(repoRoot);
}

const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".projen",
  "build",
  "tmp",
]);
const MODULE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches a barrel `index.<ext>` (as a basename or a posix path tail). */
export const BARREL_RE = /(^|\/)index\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** True if the path is a generated barrel `index.<ext>`. */
export function isBarrel(file: string): boolean {
  return BARREL_RE.test(toPosix(file));
}

/** Basenames this toolchain generates as projen files. */
const GENERATED_BASENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
]);

/**
 * True if the file is one this toolchain generates (projen manifests/tsconfigs,
 * the vite config, barrels, or declaration files) - i.e. a change to it should
 * never re-trigger the watcher.
 */
export function isGeneratedFile(file: string): boolean {
  const base = file.split(sep).pop() ?? "";
  return GENERATED_BASENAMES.has(base) || BARREL_RE.test(base) || base.endsWith(".d.ts");
}

/** Immediate subdirectory names of `dir` (ignoring build/vcs dirs); [] if missing. */
export function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !IGNORE_DIRS.has(d.name))
    .map((d) => d.name);
}

/** All files under `dir`, recursively, skipping build/vcs dirs; [] if missing. */
export function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const d of readdirSync(cur, { withFileTypes: true })) {
      if (d.isDirectory()) {
        if (!IGNORE_DIRS.has(d.name)) stack.push(join(cur, d.name));
      } else if (d.isFile()) {
        out.push(join(cur, d.name));
      }
    }
  }
  return out;
}

/** A re-exportable source module: ts/tsx/js/jsx/mjs/cjs, not a barrel/test/decl. */
export function isModuleFile(file: string): boolean {
  if (file.endsWith(".d.ts")) return false;
  if (!MODULE_EXTS.has(extname(file))) return false;
  const base = file.split(sep).pop()!;
  if (/^index\.(ts|tsx|js|jsx|mjs|cjs)$/.test(base)) return false;
  if (/\.(test|spec)\./.test(base)) return false;
  return true;
}

/** True if the file has at least one top-level `export`. */
export function hasExport(file: string): boolean {
  try {
    return /(^|\n)\s*export\b/.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

export interface DiscoveredPackage {
  readonly scope: string;
  readonly name: string;
  /** Absolute package dir. */
  readonly dir: string;
  /** Absolute `src` dir. */
  readonly src: string;
}

/**
 * Every `packages/<scope>/<name>` that has a `src/` folder containing at least
 * one module file - i.e. every package a developer has actually started.
 */
export function discoverPackagesOnDisk(): DiscoveredPackage[] {
  const out: DiscoveredPackage[] = [];
  for (const scope of listDirs(PACKAGES_DIR)) {
    for (const name of listDirs(join(PACKAGES_DIR, scope))) {
      const dir = join(PACKAGES_DIR, scope, name);
      const src = join(dir, "src");
      if (
        existsSync(src) &&
        statSync(src).isDirectory() &&
        walkFiles(src).some(isModuleFile)
      ) {
        out.push({ scope, name, dir, src });
      }
    }
  }
  return out;
}

/** The `packages/<scope>/<name>` dir of a path, or undefined if not under one. */
export function packageDirOf(file: string): string | undefined {
  const parts = file.split(sep);
  const i = parts.lastIndexOf("packages");
  if (i === -1 || parts.length < i + 3) return undefined;
  return parts.slice(0, i + 3).join(sep);
}
