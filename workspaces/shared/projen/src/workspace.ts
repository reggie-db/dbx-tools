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
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, relative, resolve, sep } from "node:path";
import { exec } from "@dbx-tools/shared-core";
import { find } from "@dbx-tools/shared-file-scan";
import { parse } from "yaml";

const SLUG_PARTS_REGEXP = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|[^A-Za-z0-9._-]+/g;

const SLUG_PARTS_EDGE_REGEXP = /^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g;

/**
 * Split a path or name fragment into normalized lowercase slug segments.
 *
 * @returns Segments used to build dashed names (`coolDude` -> `["cool", "dude"]`)
 */
export function toSlugParts(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(SLUG_PARTS_REGEXP)
    .map((part) => part.replace(SLUG_PARTS_EDGE_REGEXP, "").toLowerCase())
    .filter(Boolean);
}

/**
 * Normalize a path or name fragment to kebab-case (`coolDude` -> `cool-dude`).
 */
function toSlug(value: string): string {
  return toSlugParts(value).join("-");
}

/**
 * @deprecated Use {@link toSlugParts}.
 */
export function toNameParts(value: string | null | undefined): string[] {
  return toSlugParts(value);
}

/** Trimmed stdout from a command, or undefined when the process fails or prints nothing. */
function capturedStdout(command: string, args: string[]): string | undefined {
  const result = exec.spawnSync(command, args, {
    stdout: "capture",
    stderr: "ignore",
    stdin: "ignore",
  });
  if (result.exitCode !== 0) return undefined;
  return result.stdout || undefined;
}

/**
 * The repo root, detected (in order): `npm prefix` (nearest package root), then
 * the git top-level, then the current working directory.
 */
export const repoRoot =
  capturedStdout("npm", ["prefix"]) ??
  capturedStdout("git", ["rev-parse", "--show-toplevel"]) ??
  process.cwd();

/**
 * Default workspace-package roots. Each is scanned for packages; override via the
 * `workspacePackageRoots` option on a DBXTools project.
 */
export const DEFAULT_WORKSPACE_PACKAGE_ROOTS = ["workspaces"] as const;

/** A project name: the git remote's repo name, else the root folder name. */
export function projectName(): string {
  const url = capturedStdout("git", ["-C", repoRoot, "config", "--get", "remote.origin.url"]);
  const fromGit = url
    ?.replace(/\.git$/, "")
    .split(/[/:]/)
    .filter(Boolean)
    .pop();
  return fromGit ?? basename(repoRoot);
}

const MODULE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Glob for module files under any `src/`, built from {@link MODULE_EXTS} exts. */
const SRC_MODULE_GLOB = `**/src/**/*.{${[...MODULE_EXTS].map((e) => e.slice(1)).join(",")}}`;

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a path segment to a kebab-case tag token (`coolDude` -> `cool-dude`).
 */
function pathSegmentToTagToken(segment: string): string {
  return toSlug(segment);
}

/**
 * Cumulative nesting tags from a package's path segments relative to its discovery
 * root. The leaf folder (the package name) is excluded when there are two or more
 * segments; a lone segment tags itself.
 */
function nestingTagsFromSegments(segments: readonly string[]): string[] {
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
const BARREL_RE = /(^|\/)index\.(ts|tsx|js|jsx|mjs|cjs)$/;

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
 * True if the file matches the watcher's generated-file heuristic: projen manifest
 * basenames, package-root barrels (`index.ts`), vite config, or declaration files.
 * Other read-only toolchain output (e.g. openapi artifacts) is not covered here.
 */
export function isGeneratedFile(file: string): boolean {
  const base = file.split(sep).pop() ?? "";
  return GENERATED_BASENAMES.has(base) || BARREL_RE.test(base) || base.endsWith(".d.ts");
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

/**
 * One discovered workspace package: a `src`-bearing folder somewhere under a
 * workspace-package root, identified by that root plus the segments of its path
 * *relative to the root*. For `workspaces/ui/app` the root is `workspaces` and the
 * segments are `["ui", "app"]`.
 *
 * The relative segments drive everything downstream: the npm name
 * (`@<scope>/<segments joined by -`), the `memberPath`/`dir`, and the
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
  ) { }

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
function readWorkspaceMembers(projectRoot: string = repoRoot): string[] {
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
 * Package dirs under `rootAbs`, found with a single `find.findFiles` scan from
 * `@dbx-tools/shared-file-scan` for module files beneath any `src/`. A package is the
 * folder that OWNS the `src/` - the segments before the FIRST `src/` - so a package's
 * own subfolders never become nested packages (outermost wins). Barrels/tests/decls
 * don't count (see {@link isModuleFile}), so a `src/` holding only an `index.ts`
 * barrel is not a package. Depth is unbounded: `<root>/a/b/c/src` is discovered as
 * `a/b/c`.
 */
function collectPackageDirs(rootAbs: string): string[] {
  const owners = new Set<string>();
  for (const file of find.findFiles(SRC_MODULE_GLOB, { cwd: rootAbs })) {
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
 * its own `package.json` (both written at synth, and possibly overridden by a consumer
 * `packageMixin` - e.g. a name override). `name`/`tags` fall back to the folder
 * name / path candidates when the manifest is missing or carries none (a package
 * added but not yet synthesized).
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
 * Extra repo-root paths that trigger a full re-synth during `sync --watch`, read from
 * the root `package.json` `dbxToolsConfig.syncResynthPaths` (set via the
 * {@link DBXToolsProjectOptions.syncResynthPaths} option at synth).
 */
export function syncResynthPaths(projectRoot: string = repoRoot): string[] {
  try {
    const m = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8"));
    const paths = m?.dbxToolsConfig?.syncResynthPaths;
    if (!Array.isArray(paths)) return [];
    return paths.map((p) => String(p).trim()).filter(Boolean);
  } catch {
    return [];
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
