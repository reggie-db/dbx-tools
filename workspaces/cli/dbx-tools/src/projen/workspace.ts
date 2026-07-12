/**
 * Workspace discovery + shared filesystem helpers.
 *
 * Terminology (Bit-style): a workspace **env** is a folder directly under a
 * *workspace-env root* (e.g. `workspaces/ui` -> env `ui`) - it names the
 * environment (React/Vite, Node, agnostic, ...) its packages build for. A
 * workspace **package** is a folder under an env (`workspaces/ui/app`) whose
 * `src/` holds at least one module file (`.ts`/`.tsx`/`.js`/`.jsx`). "Scope" is
 * reserved for the npm `@scope/` in package identifiers (e.g. `@dbx-tools/ui-app`).
 *
 * `pnpm-workspace.yaml` is the SOURCE OF TRUTH for the discovered packages:
 * `configureProjen` scans the filesystem once at synth (given the configured
 * `workspaceEnvPaths`) and writes the member list there; every other command
 * (`barrels`, `typecheck`, the watcher) reads it back via {@link discoverPackages}
 * with no arguments rather than re-scanning the tree.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { parse } from "yaml";

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
 * Default workspace-env roots. Each is scanned for `<env>/<name>` packages;
 * override via `configureProjen({ workspaceEnvPaths })`.
 */
export const DEFAULT_WORKSPACE_ENV_PATHS = ["workspaces"] as const;

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
 * One discovered workspace package: `<envRoot>/<env>/<name>` (e.g.
 * `workspaces/ui/app`). Carries the pieces every consumer needs - the absolute
 * `dir` (barrels/typecheck), the repo-relative `memberPath` (pnpm member + projen
 * `outdir`), and the `envPath` used to derive the npm name.
 */
export class DiscoveredPackage {
  constructor(
    /** Absolute repo root. */
    readonly projectRoot: string,
    /** Repo-relative workspace-env root, e.g. `workspaces`. */
    readonly envRoot: string,
    /** The workspace env, e.g. `ui`. */
    readonly env: string,
    /** The package folder name, e.g. `app`. */
    readonly name: string,
  ) {}

  /** Absolute package directory. */
  get dir(): string {
    return resolve(this.projectRoot, this.envRoot, this.env, this.name);
  }

  /** Repo-relative posix member path: `workspaces/ui/app` (pnpm member + `outdir`). */
  get memberPath(): string {
    return [this.envRoot, this.env, this.name].join("/");
  }

  /** `ui/app` - env + name, the input to the npm-name derivation. */
  get envPath(): string {
    return `${this.env}/${this.name}`;
  }
}

/** Read the raw workspace member globs from `pnpm-workspace.yaml` (source of truth). */
export function readWorkspaceMembers(projectRoot: string = repoRoot): string[] {
  const file = resolve(projectRoot, "pnpm-workspace.yaml");
  if (!existsSync(file)) return [];
  const doc = parse(readFileSync(file, "utf8")) as { packages?: string[] } | null;
  return doc?.packages ?? [];
}

/** A member path is an env package iff it is exactly `<root>/<env>/<name>`. */
function envPackageOf(projectRoot: string, member: string): DiscoveredPackage | undefined {
  const segs = toPosix(member).split("/").filter(Boolean);
  if (segs.length !== 3) return undefined;
  return new DiscoveredPackage(projectRoot, segs[0]!, segs[1]!, segs[2]!);
}

/**
 * Discover workspace packages.
 *
 *  - **With `workspaceEnvPaths`** (synth time): scan the filesystem. Under each
 *    root, every `<env>/<name>` folder whose `src/` holds a module file is a
 *    package.
 *  - **Without** (every other command): read the recorded member list from
 *    `pnpm-workspace.yaml` - the source of truth - and keep the `<root>/<env>/<name>`
 *    members (non-env members like the in-tree engine are ignored).
 *
 * Returns packages sorted by member path.
 */
export function discoverPackages(
  projectRoot: string = repoRoot,
  workspaceEnvPaths?: readonly string[],
): DiscoveredPackage[] {
  const out: DiscoveredPackage[] = [];
  if (workspaceEnvPaths) {
    for (const envRoot of workspaceEnvPaths) {
      for (const envDir of listDirs(resolve(projectRoot, envRoot))) {
        for (const pkgDir of listDirs(envDir)) {
          if (hasWorkspaceSources(pkgDir)) {
            out.push(
              new DiscoveredPackage(projectRoot, envRoot, basename(envDir), basename(pkgDir)),
            );
          }
        }
      }
    }
  } else {
    for (const member of readWorkspaceMembers(projectRoot)) {
      const pkg = envPackageOf(projectRoot, member);
      if (pkg) out.push(pkg);
    }
  }
  return out.sort((a, b) => a.memberPath.localeCompare(b.memberPath));
}

/**
 * The workspace-env roots to scan for a live filesystem check: the distinct first
 * segment of every recorded env member, unioned with the defaults. Lets a command
 * compare disk against the recorded truth without knowing the `workspaceEnvPaths`
 * the last synth was configured with.
 */
export function recordedEnvRoots(projectRoot: string = repoRoot): string[] {
  const roots = new Set<string>(DEFAULT_WORKSPACE_ENV_PATHS);
  for (const member of readWorkspaceMembers(projectRoot)) {
    const pkg = envPackageOf(projectRoot, member);
    if (pkg) roots.add(pkg.envRoot);
  }
  return [...roots];
}
