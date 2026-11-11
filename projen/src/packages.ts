/**
 * Package discovery + shared filesystem helpers.
 *
 * Terminology (Bit-style): a **tag** names a target environment
 * (React/Bun, Node, agnostic, ...); a workspace **package** is a folder with a
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
 * (post-synth: barrels and validation), which is authoritative and so reflects any
 * synth-time name override or resolved tag set.
 */
import { existsSync, readFileSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { projectUtils, relativePathWithin } from "@dbx-tools/core";
import { findFilesSync } from "@dbx-tools/path";
import { parseRecord, isRecord, toSlug } from "@dbx-tools/shared-core";
import { parse } from "yaml";
import { DBXToolsConfigDataSchema, type DBXToolsConfigData } from "./dbx-tools-config.ts";
import { isGenerated } from "./generated.ts";

/** Resolve the nearest package/projenrc root at call time. */
export function resolveRepoRoot(cwd: string = process.cwd()): string {
  return projectUtils.root(cwd) ?? cwd;
}

/** Current-process repository root for executable task entrypoints. */
export const repoRoot = resolveRepoRoot();

/**
 * Default package roots. Each is scanned for packages; override via the
 * `packageRoots` option on a DBXTools project.
 */
export const DEFAULT_PACKAGE_ROOTS = ["packages"] as const;

/**
 * A project name: the root `package.json` name, else the git remote's repo
 * name, else the root folder name. Delegates to `@dbx-tools/core`'s
 * {@link projectUtils.name}, which is also what a consuming repo's own tooling
 * sees, so the engine and its host agree on the name.
 */
export function projectName(projectRoot: string = resolveRepoRoot()): string {
  return projectUtils.name(projectRoot);
}

const MODULE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Glob for module files under any `src/`, built from {@link MODULE_EXTS} exts. */
const SRC_MODULE_GLOB = `**/src/**/*.{${[...MODULE_EXTS].map((e) => e.slice(1)).join(",")}}`;

/** Convert an operating-system path to slash-separated form. */
export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Cumulative nesting tags from a package's path segments relative to its discovery
 * root. Each segment is kebab-cased with {@link stringUtils.toSlug} (`coolDude` ->
 * `cool-dude`). The leaf folder (the package name) is excluded when there are two
 * or more segments; a lone segment tags itself.
 */
function nestingTagsFromSegments(segments: readonly string[]): string[] {
  if (segments.length === 0) return [];
  const prefix = segments.length === 1 ? segments : segments.slice(0, -1);
  const out: string[] = [];
  let acc = "";
  for (const segment of prefix) {
    const token = toSlug(segment);
    if (!token) continue;
    acc = acc ? `${acc}-${token}` : token;
    out.push(acc);
  }
  return out;
}

/** Matches a barrel `index.<ext>` (as a basename or a posix path tail). */
const BARREL_RE = /(^|\/)index\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** True when a durable generated-file marker identifies the file's owner. */
export function isGeneratedFile(file: string): boolean {
  return isGenerated(file);
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
 * Return the package directory implied by a module beneath `rootDir`'s first
 * `src/` segment. Returns `undefined` for non-modules, paths outside the root,
 * and modules directly under a root-level `src/`.
 */
export function packageDirOfModule(rootDir: string, file: string): string | undefined {
  if (!isModuleFile(file)) return undefined;
  const rel = relativePathWithin(rootDir, resolve(rootDir, file));
  if (rel === undefined) return undefined;
  const segments = toPosix(rel).split("/");
  const srcIndex = segments.indexOf("src");
  if (srcIndex <= 0) return undefined;
  return resolve(rootDir, ...segments.slice(0, srcIndex));
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
   * of every ancestor folder, excluding the leaf package folder when depth >= 2.
   * Terminal `app` and `server` directories are runtime roles and replace their
   * generic ancestor (`ui/app` -> `app`, `node/server` -> `server`).
   * Other paths keep cumulative tags
   * (`shared/path/coolDude/another` -> `[shared, shared-path, shared-path-cool-dude]`).
   * Matched against `packageTagPaths` to resolve applied mixin tags.
   */
  get tagCandidates(): string[] {
    const leaf = toSlug(this.name);
    if (leaf === "app" || leaf === "server") return [leaf];
    return nestingTagsFromSegments(this.relSegments);
  }
}

/** Read the raw workspace member globs from `pnpm-workspace.yaml` (source of truth). */
function readRecordedMembers(projectRoot: string = resolveRepoRoot()): string[] {
  const file = resolve(projectRoot, "pnpm-workspace.yaml");
  if (!existsSync(file)) return [];
  const doc = parse(readFileSync(file, "utf8")) as {
    packages?: string[];
  } | null;
  return doc?.packages ?? [];
}

/** A workspace member path as a {@link DiscoveredPackage}, including root-level members. */
function packageOfMember(projectRoot: string, member: string): DiscoveredPackage | undefined {
  const segs = toPosix(member).split("/").filter(Boolean);
  if (segs.length === 0) return undefined;
  if (segs.length === 1) return new DiscoveredPackage(projectRoot, segs[0]!, []);
  return new DiscoveredPackage(projectRoot, segs[0]!, segs.slice(1));
}

/**
 * Package dirs under `rootAbs`, found with a single `find.findFilesSync` scan from
 * `@dbx-tools/path` for module files beneath any `src/`. A package is the
 * folder that OWNS the `src/` - the segments before the FIRST `src/` - so a package's
 * own subfolders never become nested packages (outermost wins). Barrels/tests/decls
 * don't count (see {@link isModuleFile}), so a `src/` holding only an `index.ts`
 * barrel is not a package. Depth is unbounded: `<root>/a/b/c/src` is discovered as
 * `a/b/c`.
 */
function collectPackageDirs(rootAbs: string): string[] {
  const owners = new Set<string>();
  for (const file of findFilesSync(SRC_MODULE_GLOB, { cwd: rootAbs })) {
    const owner = packageDirOfModule(rootAbs, file);
    if (owner) owners.add(toPosix(relative(rootAbs, owner)));
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
 * the root project's scan at synth. Sorted by member path.
 */
export function scanPackages(
  projectRoot: string = resolveRepoRoot(),
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
  /** Package name from `package.json`, when the manifest is readable and names the package. */
  readonly name?: string;
  /** Parsed `package.json`, when present and readable. */
  readonly manifest?: Readonly<Record<string, unknown>>;
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
    return parseRecord(readFileSync(path, "utf8"));
  } catch {
    return undefined; // unreadable (permissions, race with a concurrent write)
  }
}

/** A package's validated `dbxToolsConfig` object, or `undefined` when absent. */
export function readDbxToolsConfig(dir: string): DBXToolsConfigData | undefined {
  return dbxToolsConfig(readPackageManifest(dir));
}

function dbxToolsConfig(
  manifest: Readonly<Record<string, unknown>> | undefined,
): DBXToolsConfigData | undefined {
  const config = manifest?.dbxToolsConfig;
  if (config === undefined) return undefined;
  const parsed = DBXToolsConfigDataSchema.safeParse(config);
  return parsed.success ? parsed.data : undefined;
}

/** Read `<dir>/package.json`'s `dbxToolsConfig.tags` (`undefined` if absent). */
function readManifestTags(
  manifest: Readonly<Record<string, unknown>> | undefined,
): string[] | undefined {
  const tags = dbxToolsConfig(manifest)?.tags;
  return tags ? [...tags] : undefined;
}

/**
 * The recorded workspace members from `pnpm-workspace.yaml` (the source of truth),
 * each augmented with the `tags` read back from its `package.json`. This is what
 * every post-synth command uses: the manifest is
 * authoritative, so it reflects the resolved tag set.
 * Sorted by path.
 */
export function recordedPackages(projectRoot: string = resolveRepoRoot()): RecordedPackage[] {
  const out: RecordedPackage[] = [];
  for (const member of readRecordedMembers(projectRoot)) {
    const pkg = packageOfMember(projectRoot, member);
    if (!pkg) continue;
    const manifest = readPackageManifest(pkg.dir);
    const name = typeof manifest?.name === "string" ? manifest.name : undefined;
    out.push({
      path: pkg.memberPath,
      root: pkg.root,
      relPath: pkg.relPath,
      dir: pkg.dir,
      ...(name ? { name } : {}),
      ...(manifest ? { manifest } : {}),
      tags: readManifestTags(manifest) ?? pkg.tagCandidates,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Dependency fields considered when traversing workspace package relationships. */
export interface WorkspaceDependencyOptions {
  /** Include development dependencies in addition to runtime and peer dependencies. */
  readonly includeDev?: boolean;
}

/**
 * Dependency names declared by one parsed package manifest.
 *
 * Runtime traversal includes dependencies, optional dependencies, and peer
 * dependencies. Test planning may opt into development dependencies.
 */
export function workspaceDependencyNames(
  manifest: Readonly<Record<string, unknown>>,
  options: WorkspaceDependencyOptions = {},
): string[] {
  const fields = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    ...(options.includeDev ? (["devDependencies"] as const) : []),
  ] as const;
  const names = new Set<string>();
  for (const field of fields) {
    const dependencies = manifest[field];
    if (!isRecord(dependencies)) continue;
    for (const dependency of Object.keys(dependencies)) names.add(dependency);
  }
  return [...names].sort();
}

/**
 * Absolute directories for a workspace package and its transitive runtime
 * workspace dependencies. Dependency edges come from package manifests; external
 * packages are ignored. Callers that already loaded the package catalogue may pass
 * it to avoid reading the workspace manifests again. Returns `[]` when
 * `packageName` is not a workspace member.
 */
export function workspaceDependencyDirectories(
  packageName: string,
  projectRoot: string = resolveRepoRoot(),
  recorded: readonly RecordedPackage[] = recordedPackages(projectRoot),
): string[] {
  const packages = new Map<string, { dir: string; manifest: Readonly<Record<string, unknown>> }>();
  for (const pkg of recorded) {
    if (!pkg.name || !pkg.manifest) continue;
    packages.set(pkg.name, { dir: pkg.dir, manifest: pkg.manifest });
  }
  if (!packages.has(packageName)) return [];

  const directories = new Set<string>();
  const visit = (name: string): void => {
    const pkg = packages.get(name);
    if (!pkg || directories.has(pkg.dir)) return;
    directories.add(pkg.dir);
    for (const dependency of workspaceDependencyNames(pkg.manifest)) visit(dependency);
  };
  visit(packageName);
  return [...directories].sort();
}
