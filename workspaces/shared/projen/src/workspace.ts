/**
 * Workspace discovery + shared filesystem helpers.
 *
 * Terminology (Bit-style): a workspace **tag** names a target environment
 * (React/Vite, Node, agnostic, ...); a workspace **package** is a folder with a
 * `src/` holding at least one module file (`.ts`/`.tsx`/`.js`/`.jsx`). "Scope" is
 * reserved for the npm `@scope/` in package identifiers (e.g. `@dbx-tools/ui-app`).
 *
 * A package is discovered by scanning the {@link workspacePackageRoots} (default
 * `["workspaces"]`). Its path *relative to the root* drives everything: the path
 * segments join with `-` cumulatively into {@link DiscoveredPackage.tagCandidates}
 * (e.g. `shared/path/coolDude/another` -> `[shared, shared-path, shared-path-cool-dude]`:
 * each ancestor folder under the root, kebab-cased, excluding the leaf package
 * folder), and those candidates are matched against `workspacePackageTagPaths` to decide which tag(s)
 * apply. The match may yield NO tags - that is fine (the package still gets the
 * agnostic default).
 *
 * Two discovery entry points. {@link scanPackages} walks the filesystem under the
 * roots (synth time): it returns each package's path plus the tags implied by its
 * path relative to the root, reading NO manifest. {@link workspacePackages} reads
 * the recorded members from `pnpm-workspace.yaml` - the SOURCE OF TRUTH - and
 * augments each with the `name` and `tags` read back from its own `package.json`
 * (post-synth: barrels, watch, openapi), which is authoritative and so reflects any
 * synth-time name override or resolved tag set.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { find } from "@dbx-tools/shared-file-scan";
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
  tryCmd("npm", ["prefix"]) ?? tryCmd("git", ["rev-parse", "--show-toplevel"]) ?? process.cwd();

/**
 * Default workspace-package roots. Each is scanned for packages; override via the
 * `workspacePackageRoots` option on a DBXTools project.
 */
export const DEFAULT_WORKSPACE_PACKAGE_ROOTS = ["workspaces"] as const;

/** A project name: the git remote's repo name, else the root folder name. */
export function projectName(): string {
  const url = tryCmd("git", ["-C", repoRoot, "config", "--get", "remote.origin.url"]);
  const fromGit = url
    ?.replace(/\.git$/, "")
    .split(/[/:]/)
    .filter(Boolean)
    .pop();
  return fromGit ?? basename(repoRoot);
}

/** Dir names walks/globs skip: vendored, build output, VCS, and projen's own state. */
export const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "lib",
  ".git",
  ".projen",
  "build",
  "tmp",
]);
const MODULE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Glob for module files under any `src/`, built from {@link MODULE_EXTS} exts. */
const SRC_MODULE_GLOB = `**/src/**/*.{${[...MODULE_EXTS].map((e) => e.slice(1)).join(",")}}`;

/** Ignores layered on top of file-scan's built-in groups for projen scans and watch. */
export const SCAN_EXTRA_IGNORE = ["**/lib/**", "**/.projen/**"] as const;

function scanFindOptions(
  cwd: string,
  options?: Pick<find.FileFindOptions, "ignore" | "ignoreOptions">,
): find.FileFindOptions {
  const { ignore, ...rest } = options ?? {};
  const mergedIgnore =
    ignore === undefined
      ? [...SCAN_EXTRA_IGNORE]
      : Array.isArray(ignore)
        ? [...ignore, ...SCAN_EXTRA_IGNORE]
        : [ignore, ...SCAN_EXTRA_IGNORE];
  return { cwd, ...rest, ignore: mergedIgnore };
}

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * True if any segment of `p` is an ignored dir name ({@link IGNORE_DIRS}:
 * vendored, build output, VCS, projen state). The single shared test the watcher
 * uses to skip changes under `node_modules`/`dist`/`.git`/`.projen`/... - so the
 * ignore set lives in exactly one place.
 */
export function isIgnoredPath(p: string): boolean {
  return toPosix(p)
    .split("/")
    .some((seg) => IGNORE_DIRS.has(seg));
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a path segment to a kebab-case tag token (`coolDude` -> `cool-dude`,
 * `pnpm-workspace` -> `pnpm-workspace`).
 */
export function pathSegmentToTagToken(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("-");
}

/**
 * Cumulative nesting tags from a package's path segments relative to its discovery
 * root. The leaf folder (the package name) is excluded when there are two or more
 * segments; a lone segment tags itself.
 */
export function nestingTagsFromSegments(segments: readonly string[]): string[] {
  if (segments.length === 0) return [];
  const prefix = segments.length === 1 ? segments : segments.slice(0, -1);
  const out: string[] = [];
  let acc = "";
  for (const segment of prefix) {
    const token = pathSegmentToTagToken(segment);
    if (!token) continue;
    acc = acc ? `${acc}-${token}` : token;
    out.push(acc);
  }
  return out;
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

/**
 * All files under `dir`, recursively, using {@link findFiles} with the shared
 * ignore groups plus projen's {@link SCAN_EXTRA_IGNORE}. When `skipDir` is set
 * (as `clean` does for dot-prefixed folders), dot-directories are ignored too.
 */
export function walkFiles(
  dir: string,
  _ignore: ReadonlySet<string> = IGNORE_DIRS,
  skipDir?: (name: string) => boolean,
): string[] {
  if (!existsSync(dir)) return [];
  return [
    ...find.findFiles("**/*", scanFindOptions(dir, { ignoreOptions: { dot: skipDir !== undefined } })),
  ].map((rel) => join(dir, rel));
}

/** A re-exportable source module: ts/tsx/js/jsx/mjs/cjs, not a barrel/test/decl. */
export function isModuleFile(file: string): boolean {
  if (file.endsWith(".d.ts")) return false;
  if (!MODULE_EXTS.has(extname(file))) return false;
  // Accept both OS-native paths and posix (glob) inputs.
  const base = toPosix(file).split("/").pop()!;
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

/**
 * One discovered workspace package: a `src`-bearing folder somewhere under a
 * workspace-package root, identified by that root plus the segments of its path
 * *relative to the root*. For `workspaces/ui/app` the root is `workspaces` and the
 * segments are `["ui", "app"]`.
 *
 * The relative segments drive everything downstream: the npm name
 * (`@<scope>/<segments joined by ->`), the `memberPath`/`dir`, and the
 * {@link tagCandidates} used to resolve which tag(s) apply.
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
   * Tag candidates from nesting under the discovery root: cumulative kebab-case join
   * of every ancestor folder, excluding the leaf package folder when depth >= 2
   * (`shared/path/coolDude/another` -> `[shared, shared-path, shared-path-cool-dude]`).
   * Matched against `workspacePackageTagPaths` to resolve applied mixin tags.
   */
  get tagCandidates(): string[] {
    return nestingTagsFromSegments(this.relSegments);
  }
}

/** Read the raw workspace member globs from `pnpm-workspace.yaml` (source of truth). */
export function readWorkspaceMembers(projectRoot: string = repoRoot): string[] {
  const file = resolve(projectRoot, "pnpm-workspace.yaml");
  if (!existsSync(file)) return [];
  const doc = parse(readFileSync(file, "utf8")) as {
    packages?: string[];
  } | null;
  return doc?.packages ?? [];
}

/** A member path `<root>/<...rel>` (>= 2 segments) as a {@link DiscoveredPackage}. */
function packageOfMember(projectRoot: string, member: string): DiscoveredPackage | undefined {
  const segs = toPosix(member).split("/").filter(Boolean);
  if (segs.length < 2) return undefined;
  return new DiscoveredPackage(projectRoot, segs[0]!, segs.slice(1));
}

/**
 * Package dirs under `rootAbs`, found with a single {@link findFiles} scan for module
 * files beneath any `src/`. A package is the folder that OWNS the `src/` - the
 * segments before the FIRST `src/` - so a package's own subfolders never become
 * nested packages (outermost wins). Barrels/tests/decls don't count (see
 * {@link isModuleFile}), so a `src/` holding only an `index.ts` barrel is not a
 * package. Depth is unbounded: `<root>/a/b/c/src` is discovered as `a/b/c`.
 */
function collectPackageDirs(rootAbs: string): string[] {
  const owners = new Set<string>();
  for (const file of find.findFiles(SRC_MODULE_GLOB, scanFindOptions(rootAbs))) {
    if (!isModuleFile(file)) continue;
    const segs = toPosix(file).split("/");
    const srcIdx = segs.indexOf("src");
    if (srcIdx > 0) owners.add(segs.slice(0, srcIdx).join("/"));
  }
  const rels = [...owners];
  // Outermost wins: drop any owner nested under another discovered owner.
  return rels
    .filter((d) => !rels.some((o) => o !== d && d.startsWith(`${o}/`)))
    .map((rel) => resolve(rootAbs, rel));
}

/**
 * Scan the filesystem for packages under `roots` (synth time): every `src`-bearing
 * folder, at any depth, is one. Returns each as a {@link DiscoveredPackage} - its
 * path plus the tags implied by its path relative to the root
 * ({@link DiscoveredPackage.tagCandidates}); no `package.json` is read. Used by
 * the root project's scan at synth, and by the watcher to compare disk against the
 * recorded set. Sorted by member path.
 */
export function scanPackages(
  projectRoot: string = repoRoot,
  roots: readonly string[] = DEFAULT_WORKSPACE_PACKAGE_ROOTS,
): DiscoveredPackage[] {
  const out: DiscoveredPackage[] = [];
  for (const root of roots) {
    const rootAbs = resolve(projectRoot, root);
    for (const pkgDir of collectPackageDirs(rootAbs)) {
      const rel = toPosix(relative(rootAbs, pkgDir)).split("/").filter(Boolean);
      out.push(new DiscoveredPackage(projectRoot, root, rel));
    }
  }
  return out.sort((a, b) => a.memberPath.localeCompare(b.memberPath));
}

/**
 * A recorded workspace package: its path, plus the `name` and `tags` read back from
 * its own `package.json` (both written at synth, and possibly REWRITTEN by a
 * `workspacePackage` hook - e.g. a name override). `name`/`tags` fall back to the
 * folder name / path candidates when the manifest is missing or carries none (a
 * package added but not yet synthesized).
 */
export interface WorkspacePackage {
  /** Repo-relative posix member path, e.g. `workspaces/ui/app`. */
  readonly path: string;
  /** Repo-relative workspace-package root, e.g. `workspaces`. */
  readonly root: string;
  /** Posix path relative to the root, e.g. `ui/app`. */
  readonly relPath: string;
  /** Absolute package directory. */
  readonly dir: string;
  /** The npm name from `package.json` (`@dbx-tools/ui-app`), else the folder name. */
  readonly name: string;
  /** Resolved tags from `package.json` `dbxToolsConfig.tags`, else the path candidates. */
  readonly tags: string[];
}

/** Read `<dir>/package.json`'s `name` + `dbxToolsConfig.tags` (each `undefined` if absent). */
function readManifest(dir: string): { name?: string; tags?: string[] } {
  try {
    const m = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
    const tags = m?.dbxToolsConfig?.tags;
    return {
      name: typeof m?.name === "string" ? m.name : undefined,
      tags: Array.isArray(tags) ? (tags as string[]) : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * The recorded workspace members from `pnpm-workspace.yaml` (the source of truth),
 * each augmented with the `name` + `tags` read back from its `package.json`. This is
 * what every post-synth command (barrels, watch, openapi) uses: the manifest is
 * authoritative, so it reflects any synth-time name override or resolved tag set.
 * Sorted by path.
 */
export function workspacePackages(projectRoot: string = repoRoot): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  for (const member of readWorkspaceMembers(projectRoot)) {
    const pkg = packageOfMember(projectRoot, member);
    if (!pkg) continue;
    const manifest = readManifest(pkg.dir);
    out.push({
      path: pkg.memberPath,
      root: pkg.root,
      relPath: pkg.relPath,
      dir: pkg.dir,
      name: manifest.name ?? pkg.name,
      tags: manifest.tags ?? pkg.tagCandidates,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
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
