/**
 * Workspace discovery + shared filesystem helpers.
 *
 * Terminology (Bit-style): a workspace **env** names a target environment
 * (React/Vite, Node, agnostic, ...); a workspace **package** is a folder with a
 * `src/` holding at least one module file (`.ts`/`.tsx`/`.js`/`.jsx`). "Scope" is
 * reserved for the npm `@scope/` in package identifiers (e.g. `@dbx-tools/ui-app`).
 *
 * A package is discovered by scanning the {@link workspacePackageRoots} (default
 * `["workspaces"]`). Its path *relative to the root* drives everything: the path
 * segments join with `-` cumulatively into {@link DiscoveredPackage.envCandidates}
 * (e.g. `dir/another/path` -> `[dir, dir-another, dir-another-path]`), and those
 * candidates are matched against `workspacePackageEnvPaths` to decide which env(s)
 * apply. The match may yield NO envs - that is fine (the package still gets the
 * agnostic default).
 *
 * `pnpm-workspace.yaml` is the SOURCE OF TRUTH for the discovered member set:
 * `configureProjen` scans the filesystem once at synth (given the roots) and the
 * members flow from `project.subprojects`; every other command reads them back via
 * {@link discoverPackages} with no roots argument rather than re-scanning.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";

/** A value that may be given as a single item or an array of them. */
export type OneOrMany<T> = T | T[];

/** Normalize a {@link OneOrMany} (or `undefined`) into an array. */
export function toArray<T>(value?: OneOrMany<T>): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

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

/**
 * Default workspace-package roots. Each is scanned for packages; override via
 * `configureProjen({ workspacePackageRoots })`.
 */
export const DEFAULT_WORKSPACE_PACKAGE_ROOTS = ["workspaces"] as const;

/** A project name: the git remote's repo name, else the root folder name. */
export function projectName(): string {
  const url = tryCmd("git", ["-C", repoRoot, "config", "--get", "remote.origin.url"]);
  const fromGit = url?.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop();
  return fromGit ?? basename(repoRoot);
}

const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "lib",
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

/** Basenames this toolchain generates (projen manifests/tsconfigs + vite config). */
const GENERATED_BASENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.dev.json",
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

/** Absolute paths of `dir`'s immediate subdirectories (ignoring build/vcs dirs); [] if missing. */
export function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !IGNORE_DIRS.has(d.name))
    .map((d) => resolve(dir, d.name));
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
  if (BARREL_RE.test(base)) return false;
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

/** True if `<dir>/src` exists and holds at least one module file. */
export function hasWorkspaceSources(dir: string): boolean {
  return walkFiles(join(dir, "src")).some(isModuleFile);
}

/**
 * One discovered workspace package: a `src`-bearing folder somewhere under a
 * workspace-package root, identified by that root plus the segments of its path
 * *relative to the root*. For `workspaces/ui/app` the root is `workspaces` and the
 * segments are `["ui", "app"]`.
 *
 * The relative segments drive everything downstream: the npm name
 * (`@<scope>/<segments joined by ->`), the `memberPath`/`dir`, and the
 * {@link envCandidates} used to resolve which env(s) apply.
 */
export class DiscoveredPackage {
  constructor(
    /** Absolute repo root. */
    readonly projectRoot: string,
    /** Repo-relative workspace-package root, e.g. `workspaces`. */
    readonly root: string,
    /** Path segments relative to `root`, e.g. `["ui", "app"]`. */
    readonly relSegments: readonly string[],
  ) {}

  /** Posix path relative to the root, e.g. `ui/app`. */
  get relPath(): string {
    return this.relSegments.join("/");
  }

  /** Repo-relative posix member path: `workspaces/ui/app` (pnpm member + `outdir`). */
  get memberPath(): string {
    return [this.root, ...this.relSegments].join("/");
  }

  /** Absolute package directory. */
  get dir(): string {
    return resolve(this.projectRoot, this.root, ...this.relSegments);
  }

  /** The package folder name (last segment), e.g. `app`. */
  get name(): string {
    return this.relSegments[this.relSegments.length - 1] ?? this.root;
  }

  /**
   * Env-name candidates derived from the relative segments by cumulative `-`
   * join: `["dir", "another", "path"]` -> `["dir", "dir-another", "dir-another-path"]`.
   * Matched (as a set) against `workspacePackageEnvPaths` to resolve applied envs.
   */
  get envCandidates(): string[] {
    const out: string[] = [];
    let acc = "";
    for (const seg of this.relSegments) {
      acc = acc ? `${acc}-${seg}` : seg;
      out.push(acc);
    }
    return out;
  }
}

/** Read the raw workspace member globs from `pnpm-workspace.yaml` (source of truth). */
export function readWorkspaceMembers(projectRoot: string = repoRoot): string[] {
  const file = resolve(projectRoot, "pnpm-workspace.yaml");
  if (!existsSync(file)) return [];
  const doc = parse(readFileSync(file, "utf8")) as { packages?: string[] } | null;
  return doc?.packages ?? [];
}

/** A member path `<root>/<...rel>` (>= 2 segments) as a {@link DiscoveredPackage}. */
function packageOfMember(projectRoot: string, member: string): DiscoveredPackage | undefined {
  const segs = toPosix(member).split("/").filter(Boolean);
  if (segs.length < 2) return undefined;
  return new DiscoveredPackage(projectRoot, segs[0]!, segs.slice(1));
}

/**
 * Recursively collect package dirs under `rootAbs`: a directory whose `src/` holds
 * a module file is a package (and we do NOT descend into it, so a package's own
 * subfolders never become nested packages). Depth is unbounded, so
 * `<root>/a/b/c/src` is discovered as the package `a/b/c`.
 */
function collectPackageDirs(rootAbs: string): string[] {
  const out: string[] = [];
  const visit = (dirAbs: string): void => {
    if (hasWorkspaceSources(dirAbs)) {
      out.push(dirAbs);
      return; // this dir is a package; its subtree belongs to it
    }
    for (const child of listDirs(dirAbs)) visit(child);
  };
  for (const child of listDirs(rootAbs)) visit(child);
  return out;
}

/**
 * Discover workspace packages.
 *
 *  - **With `roots`** (synth time): scan the filesystem. Under each root, every
 *    `src`-bearing folder (at any depth) is a package.
 *  - **Without** (every other command): read the recorded member list from
 *    `pnpm-workspace.yaml` - the source of truth.
 *
 * Returns packages sorted by member path.
 */
export function discoverPackages(
  projectRoot: string = repoRoot,
  roots?: readonly string[],
): DiscoveredPackage[] {
  const out: DiscoveredPackage[] = [];
  if (roots) {
    for (const root of roots) {
      const rootAbs = resolve(projectRoot, root);
      for (const pkgDir of collectPackageDirs(rootAbs)) {
        const rel = toPosix(relative(rootAbs, pkgDir)).split("/").filter(Boolean);
        out.push(new DiscoveredPackage(projectRoot, root, rel));
      }
    }
  } else {
    for (const member of readWorkspaceMembers(projectRoot)) {
      const pkg = packageOfMember(projectRoot, member);
      if (pkg) out.push(pkg);
    }
  }
  return out.sort((a, b) => a.memberPath.localeCompare(b.memberPath));
}

/**
 * The roots to scan for a live filesystem check: the distinct first segment of
 * every recorded member, unioned with the defaults. Lets a command compare disk
 * against the recorded truth without knowing the `workspacePackageRoots` the last
 * synth was configured with.
 */
export function recordedRoots(projectRoot: string = repoRoot): string[] {
  const roots = new Set<string>(DEFAULT_WORKSPACE_PACKAGE_ROOTS);
  for (const member of readWorkspaceMembers(projectRoot)) {
    const pkg = packageOfMember(projectRoot, member);
    if (pkg) roots.add(pkg.root);
  }
  return [...roots];
}
