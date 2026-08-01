/**
 * Package discovery + shared filesystem helpers.
 *
 * Terminology (Bit-style): a **tag** names a target environment
 * (React/Vite, Node, agnostic, ...); a workspace **package** is a folder with a
 * `src/` holding at least one module file (`.ts`/`.tsx`/`.js`/`.jsx`). "Scope" is
 * reserved for the npm `@scope/` in package identifiers (e.g. `@dbx-tools/ui-app`).
 *
 * A package is discovered by scanning the {@link packageRoots} (default
 * `["packages"]`). Its path *relative to the root* drives everything: the path
 * segments join with `-` cumulatively into {@link DiscoveredPackage.tagCandidates}
 * (e.g. `shared/path/coolDude/another` -> `[shared, shared-path, shared-path-cool-dude]`:
 * each ancestor folder under the root, kebab-cased, excluding the leaf package
 * folder), and those candidates are matched against `packageTagPaths` to decide which tag(s)
 * apply. The match may yield NO tags - that is fine (the package still gets the
 * agnostic default).
 *
 * Two discovery entry points. {@link scanPackages} walks the filesystem under the
 * roots (synth time): it returns each package's path plus the tags implied by its
 * path relative to the root, reading NO manifest. {@link recordedPackages} reads
 * the recorded members from `pnpm-workspace.yaml` - the SOURCE OF TRUTH - and
 * augments each with the `name` and `tags` read back from its own `package.json`
 * (post-synth: barrels, watch, openapi), which is authoritative and so reflects any
 * synth-time name override or resolved tag set.
 */
import { existsSync, readFileSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { project as coreProject } from "@dbx-tools/core";
import { json, object, string } from "@dbx-tools/shared-core";
import { find } from "@dbx-tools/path";
import { parse } from "yaml";

/**
 * The repo root: the nearest package/projenrc root, falling back to the current
 * working directory. Detection (npm prefix, git top-level, root markers) lives
 * in `@dbx-tools/core`'s {@link coreProject.root}.
 */
export const repoRoot = coreProject.root() ?? process.cwd();

/**
 * Default package roots. Each is scanned for packages; override via the
 * `packageRoots` option on a DBXTools project.
 */
export const DEFAULT_PACKAGE_ROOTS = ["packages"] as const;

/**
 * A project name: the root `package.json` name, else the git remote's repo
 * name, else the root folder name. Delegates to `@dbx-tools/core`'s
 * {@link coreProject.name}, which is also what a consuming repo's own tooling
 * sees, so the engine and its host agree on the name.
 */
export function projectName(): string {
  return coreProject.name(repoRoot);
}

const MODULE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Glob for module files under any `src/`, built from {@link MODULE_EXTS} exts. */
const SRC_MODULE_GLOB = `**/src/**/*.{${[...MODULE_EXTS].map((e) => e.slice(1)).join(",")}}`;

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Cumulative nesting tags from a package's path segments relative to its discovery
 * root. Each segment is kebab-cased with {@link string.toSlug} (`coolDude` ->
 * `cool-dude`). The leaf folder (the package name) is excluded when there are two
 * or more segments; a lone segment tags itself.
 */
function nestingTagsFromSegments(segments: readonly string[]): string[] {
  if (segments.length === 0) return [];
  const prefix = segments.length === 1 ? segments : segments.slice(0, -1);
  const out: string[] = [];
  let acc = "";
  for (const segment of prefix) {
    const token = string.toSlug(segment);
    if (!token) continue;
    acc = acc ? `${acc}-${token}` : token;
    out.push(acc);
  }
  return out;
}

/** Matches a barrel `index.<ext>` (as a basename or a posix path tail). */
const BARREL_RE = /(^|\/)index\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Basenames this toolchain generates (projen manifests/tsconfigs + bun app scaffolding). */
const GENERATED_BASENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.dev.json",
  "bunfig.toml",
  "dev.ts",
  "build.ts",
]);

/**
 * True if the file matches the watcher's generated-file heuristic: projen manifest
 * basenames, package-root barrels (`index.ts`), bun app scaffolding, or declaration
 * files. Other read-only toolchain output (e.g. openapi artifacts) is not covered here.
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
 * One discovered package: a `src`-bearing folder somewhere under a
 * package root, identified by that root plus the segments of its path
 * *relative to the root*. For `packages/ui/app` the root is `packages` and the
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
    /** Repo-relative package root, e.g. `packages`. */
    readonly root: string,
    /** Path segments relative to `root`, e.g. `["ui", "app"]`. */
    readonly relSegments: readonly string[],
  ) {}

  /** Posix path relative to the root, e.g. `ui/app`. */
  get relPath(): string {
    return this.relSegments.join("/");
  }

  /** Repo-relative posix member path: `packages/ui/app` (pnpm member + `outdir`). */
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
   * Matched against `packageTagPaths` to resolve applied mixin tags.
   */
  get tagCandidates(): string[] {
    return nestingTagsFromSegments(this.relSegments);
  }
}

/** Read the raw workspace member globs from `pnpm-workspace.yaml` (source of truth). */
function readRecordedMembers(projectRoot: string = repoRoot): string[] {
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
 * `@dbx-tools/path` for module files beneath any `src/`. A package is the
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
  roots: readonly string[] = DEFAULT_PACKAGE_ROOTS,
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
 * A recorded package: its path, plus the `name` and `tags` read back from
 * its own `package.json` (both written at synth, and possibly overridden by a consumer
 * `packageMixin` - e.g. a name override). `name`/`tags` fall back to the folder
 * name / path candidates when the manifest is missing or carries none (a package
 * added but not yet synthesized).
 */
export interface RecordedPackage {
  /** Repo-relative posix member path, e.g. `packages/ui/app`. */
  readonly path: string;
  /** Repo-relative package root, e.g. `packages`. */
  readonly root: string;
  /** Posix path relative to the root, e.g. `ui/app`. */
  readonly relPath: string;
  /** Absolute package directory. */
  readonly dir: string;
  /** Resolved tags from `package.json` `dbxToolsConfig.tags`, else the path candidates. */
  readonly tags: string[];
}

/**
 * `<dir>/package.json` parsed as a record, or `undefined` when the file is
 * absent or malformed. The single manifest reader for the engine - every
 * caller that pokes at a `package.json` field goes through this so a missing or
 * half-written manifest degrades the same way everywhere.
 */
export function readPackageManifest(dir: string): Record<string, unknown> | undefined {
  const path = resolve(dir, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    return json.parseRecord(readFileSync(path, "utf8"));
  } catch {
    return undefined; // unreadable (permissions, race with a concurrent write)
  }
}

/** A package's `dbxToolsConfig` object, or `undefined` when absent. */
function readDbxToolsConfig(dir: string): Record<string, unknown> | undefined {
  const config = readPackageManifest(dir)?.dbxToolsConfig;
  return object.isRecord(config) ? config : undefined;
}

/** Read `<dir>/package.json`'s `dbxToolsConfig.tags` (`undefined` if absent). */
function readManifestTags(dir: string): string[] | undefined {
  const tags = readDbxToolsConfig(dir)?.tags;
  return Array.isArray(tags) ? (tags as string[]) : undefined;
}

/**
 * Extra repo-root paths that trigger a full re-synth during `sync --watch`, read from
 * the root `package.json` `dbxToolsConfig.syncResynthPaths` (set via the
 * {@link DBXToolsProjectOptions.syncResynthPaths} option at synth).
 */
export function syncResynthPaths(projectRoot: string = repoRoot): string[] {
  const paths = readDbxToolsConfig(projectRoot)?.syncResynthPaths;
  return Array.isArray(paths) ? string.parseList(paths.map((p) => String(p))) : [];
}

/**
 * The recorded workspace members from `pnpm-workspace.yaml` (the source of truth),
 * each augmented with the `tags` read back from its `package.json`. This is what
 * every post-synth command (barrels, watch, openapi) uses: the manifest is
 * authoritative, so it reflects the resolved tag set.
 * Sorted by path.
 */
export function recordedPackages(projectRoot: string = repoRoot): RecordedPackage[] {
  const out: RecordedPackage[] = [];
  for (const member of readRecordedMembers(projectRoot)) {
    const pkg = packageOfMember(projectRoot, member);
    if (!pkg) continue;
    out.push({
      path: pkg.memberPath,
      root: pkg.root,
      relPath: pkg.relPath,
      dir: pkg.dir,
      tags: readManifestTags(pkg.dir) ?? pkg.tagCandidates,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The roots to scan for a live filesystem check: the distinct first segment of
 * every recorded member, unioned with the defaults. Lets a command compare disk
 * against the recorded truth without knowing the `packageRoots` the last
 * synth was configured with.
 */
export function recordedRoots(projectRoot: string = repoRoot): string[] {
  const roots = new Set<string>(DEFAULT_PACKAGE_ROOTS);
  for (const member of readRecordedMembers(projectRoot)) {
    const pkg = packageOfMember(projectRoot, member);
    if (pkg) roots.add(pkg.root);
  }
  return [...roots];
}
