/**
 * The two project classes you instantiate, plus the shared init that turns a
 * root into a tag-enforcing pnpm monorepo.
 *
 * - `DBXToolsNodeProject` (monorepo root) and `DBXToolsTypeScriptProject` (a
 *   package, or a standalone compiling root) share `DBXToolsCommonOptions` and the
 *   DBXTools-specific surface both expose: the `dbxToolsConfig` component (tags
 *   live here - `project.dbxToolsConfig.appendTag(...)` - reading/writing
 *   `package.json` `dbxToolsConfig.tags`), `scope` + `packageNameFor` (npm
 *   naming), and the `pnpmWorkspace` field (the root's
 *   {@link DBXToolsPNPMWorkspace}).
 * - Passing `workspacePackageRoots` makes a ROOT scan those roots and append a
 *   `DBXToolsTypeScriptProject` child per `src`-bearing folder, resolving each
 *   child's tags (path-derived, ∪ `workspacePackageTagPaths`) and scope-based npm
 *   name. Every package gets the agnostic tsconfig floor at construction; per-tag
 *   deps/tsconfig/tasks come from the {@link WORKSPACE_TAG_MIXINS} applied via
 *   `construct.with(...)` across the subtree during the root's construction, and
 *   per-package tweaks are user mixins the caller applies with `project.with(...)`.
 * - The root also emits the shared config (tsconfig base/root, prettier, vscode,
 *   `pnpm-workspace.yaml`), the native projen tasks (`barrels`/`typecheck`/
 *   `openapi`, and a `sync` task that runs the watches concurrently), barrels on
 *   synth, and `annotateGenerated`.
 *
 * Replaces the removed `configureProject()` function.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Component, type TaskOptions, javascript, typescript } from "projen";
import { generateBarrels } from "./barrels";
import * as files from "./files";
import { type DefaultTagMixinName, resolveDefaultTagMixins } from "./mixins";
import {
  SHARED_COMPILER_OPTIONS,
  SUBPROJECT_DEFAULTS as PROJECT_DEFAULTS,
  addWorkspacePackageTags,
  applyTasks,
  emitViteConfig,
  lockPackageJson,
  npmNameOf,
} from "./packages";
import { DBXToolsPNPMWorkspace, type DBXToolsPNPMWorkspaceOptions } from "./pnpm-workspace";
import { AGNOSTIC_COMPILER_OPTIONS, WORKSPACE_TAG_MIXINS, type WorkspaceTag } from "./tags";
import {
  DEFAULT_WORKSPACE_PACKAGE_ROOTS,
  type DiscoveredPackage,
  escapeRegExp,
  projectName,
  scanPackages,
  toPosix,
} from "./workspace";

/**
 * The engine's opinionated `NodeProject` defaults for the monorepo root. Any
 * option a caller passes overrides these; `name`/`defaultReleaseBranch` are
 * resolved/applied separately.
 */
const NODE_ENGINE_DEFAULTS: Partial<javascript.NodeProjectOptions> = {
  packageManager: javascript.NodePackageManager.PNPM,
  projenrcJs: false,
  buildWorkflow: false,
  release: false,
  jest: false,
  prettier: false,
  github: false,
  npmignoreEnabled: false,
  licensed: false,
  entrypoint: "",
  depsUpgrade: false,
  peerDependencyOptions: { pinnedDevDependency: false },
  addPackageManagerToDevEngines: false,
};

/** Options shared by both DBXTools project classes. */
export interface DBXToolsCommonOptions {
  /**
   * The npm scope for generated package names (`@<scope>/<seg-...>`). Defaults to
   * the (resolved) project name; a leading `@` is optional.
   */
  readonly scope?: string;
  /**
   * Roots scanned for packages (each `src`-bearing folder under a root is one).
   * Only a ROOT scans. Defaults to {@link DEFAULT_WORKSPACE_PACKAGE_ROOTS}.
   */
  readonly workspacePackageRoots?: readonly string[];
  /**
   * Maps a path token / relPath / glob to tag(s), unioned into a package's
   * path-derived tags. Defaults to an identity map over the known tag names; a
   * `""`/`"."` key tags the root.
   */
  readonly workspacePackageTagPaths?: Record<string, string[]>;
  /**
   * Built-in tag names to NOT apply. A disabled tag is dropped from both the
   * identity tag-path map and the applied {@link WORKSPACE_TAG_MIXINS}, so its
   * packages fall back to the agnostic floor.
   */
  readonly disableWorkspaceTags?: readonly string[];
  /**
   * Which built-in "default" tag mixins to layer on top of {@link WORKSPACE_TAG_MIXINS}
   * (e.g. the opinionated `server` Express layer). Defaults to `"all"`.
   */
  readonly defaultTagMixins?: DefaultTagMixinName[] | "all";
  /** Options for the root's {@link DBXToolsPNPMWorkspace} (`pnpm-workspace.yaml`). */
  readonly pnpmWorkspace?: DBXToolsPNPMWorkspaceOptions;
  /** Initial `dbxToolsConfig` (`package.json`) for this project - e.g. its `tags`. */
  readonly dbxToolsConfig?: DBXToolsConfigOptions;
}



/** Options for {@link DBXToolsNodeProject} (the monorepo root). */
export interface DBXToolsNodeProjectOptions
  extends Partial<javascript.NodeProjectOptions>,
  DBXToolsCommonOptions { }

/** Options for {@link DBXToolsTypeScriptProject} (a package, or a compiling root). */
export interface DBXToolsTypeScriptProjectOptions
  extends Partial<typescript.TypeScriptProjectOptions>,
  DBXToolsCommonOptions {
  /** Extra projen tasks for this package (name -> `TaskOptions`). */
  readonly tasks?: Record<string, TaskOptions>;
  /** Emit a projen-owned `vite.config.ts`. */
  readonly viteConfig?: boolean;
}

/** Options for the {@link DBXToolsConfig} component / the `dbxToolsConfig` field. */
export interface DBXToolsConfigOptions {
  /** Initial tags to record (distinct; order preserved). */
  readonly tags?: string[];
}

/**
 * Owns the package's `dbxToolsConfig` field in `package.json` - today just `tags`,
 * the per-package source of truth every post-synth command reads back. It reads and
 * writes that field directly (no cached copy), so the manifest is always the single
 * source of truth, and preserves any sibling keys already under `dbxToolsConfig`.
 */
export class DBXToolsConfig extends Component {
  constructor(readonly project: javascript.NodeProject, options: DBXToolsConfigOptions = {}) {
    super(project);
    if (options.tags?.length) this.appendTag(...options.tags);
  }

  /** The distinct tags on `package.json` `dbxToolsConfig.tags` (empty if unset). */
  public get tags(): string[] {
    return this.read();
  }

  /** Append tags at the end, keeping the list distinct (incoming moved to the end). */
  public appendTag(...tags: string[]): void {
    if (tags.length === 0) return;
    const incoming = [...new Set(tags)];
    this.write([...this.read().filter((t) => !incoming.includes(t)), ...incoming]);
  }

  /** Prepend tags to the front, keeping the list distinct (incoming moved to front). */
  public prependTag(...tags: string[]): void {
    if (tags.length === 0) return;
    const incoming = [...new Set(tags)];
    this.write([...incoming, ...this.read().filter((t) => !incoming.includes(t))]);
  }

  /** The tags currently on the in-memory `package.json` (`[]` if unset). */
  private read(): string[] {
    const tags = this.project.package.manifest?.dbxToolsConfig?.tags;
    return Array.isArray(tags) ? [...tags] : [];
  }

  /** Write `tags` back to `dbxToolsConfig.tags`, preserving any sibling keys. */
  private write(tags: string[]): void {
    const config = this.project.package.manifest?.dbxToolsConfig ?? {};
    this.project.package.addField("dbxToolsConfig", { ...config, tags: [...new Set(tags)] });
  }
}

/**
 * The DBXTools-specific surface both project classes expose (used by the shared
 * init + mixins). Tags live on the {@link DBXToolsConfig} component, accessed
 * directly (e.g. `project.dbxToolsConfig.appendTag(...)`).
 */
export interface IDBXToolsProject {
  /** The npm scope for generated package names (no leading `@`). */
  readonly scope: string;
  /** The component that owns `package.json` `dbxToolsConfig` (tags live here). */
  readonly dbxToolsConfig: DBXToolsConfig;
  /** The `pnpm-workspace.yaml` file component (only a ROOT emits a file). */
  readonly pnpmWorkspace: DBXToolsPNPMWorkspace;
  /** The npm name for a package at `relPath` under this project's scope. */
  packageNameFor(relPath: string): string;
}

/**
 * A monorepo root. Scans `workspacePackageRoots` and appends a
 * {@link DBXToolsTypeScriptProject} per `src`-bearing folder, then emits the
 * shared config, tasks, `pnpm-workspace.yaml`, and barrels-on-synth.
 */
export class DBXToolsNodeProject extends javascript.NodeProject implements IDBXToolsProject {
  readonly scope: string;
  readonly dbxToolsConfig: DBXToolsConfig;
  readonly pnpmWorkspace: DBXToolsPNPMWorkspace;

  constructor(options: DBXToolsNodeProjectOptions = {}) {
    const { name, scope } = resolveIdentity(options);
    super({
      ...NODE_ENGINE_DEFAULTS,
      ...options,
      name,
      defaultReleaseBranch: options.defaultReleaseBranch ?? "main",
    });
    this.scope = scope;
    this.dbxToolsConfig = new DBXToolsConfig(this, options.dbxToolsConfig ?? {});
    this.pnpmWorkspace = new DBXToolsPNPMWorkspace(this, options.pnpmWorkspace ?? {});
    initDBXToolsProject(this, options);
  }

  public packageNameFor(relPath: string): string {
    return npmNameOf(this.scope, relPath);
  }
}

/**
 * A single workspace package (usually created by a root's scan), or a standalone
 * compiling root. The agnostic tsconfig floor is applied at construction; the
 * source-first package fields (`main`/`types`/`exports` -> `index.ts`), any explicit
 * `tasks`, and an optional `vite.config.ts` are applied after. Per-tag deps/tsconfig
 * arrive later via the {@link WORKSPACE_TAG_MIXINS} the root applies.
 */
export class DBXToolsTypeScriptProject extends typescript.TypeScriptProject implements IDBXToolsProject {
  readonly scope: string;
  readonly dbxToolsConfig: DBXToolsConfig;
  readonly pnpmWorkspace: DBXToolsPNPMWorkspace;

  constructor(options: DBXToolsTypeScriptProjectOptions) {
    const { name, scope } = resolveIdentity(options);
    const parent = options?.parent;
    const packageManager =
      options.packageManager ??
      (parent instanceof javascript.NodeProject
        ? parent.package.packageManager
        : javascript.NodePackageManager.PNPM);

    super({
      ...PROJECT_DEFAULTS,
      ...options,
      name: options.name ?? name,
      defaultReleaseBranch: options.defaultReleaseBranch ?? "main",
      packageManager,
      tsconfig: {
        ...options.tsconfig,
        include: options.tsconfig?.include,
        // Every package starts from the agnostic floor (ES2022, no DOM/node); a tag
        // mixin layers its `lib`/`jsx`/`types` on top afterward via `project.with`.
        compilerOptions: {
          ...SHARED_COMPILER_OPTIONS,
          ...AGNOSTIC_COMPILER_OPTIONS,
          ...options.tsconfig?.compilerOptions,
        },
      },
    });

    this.scope = scope;
    this.dbxToolsConfig = new DBXToolsConfig(this, options.dbxToolsConfig ?? {});
    this.pnpmWorkspace = new DBXToolsPNPMWorkspace(this, options.pnpmWorkspace ?? {});

    // Source-first entry: point the package at its package-ROOT `index.ts` barrel
    // so workspace packages resolve each other's `@scope/pkg` imports to source.
    this.package.addField("type", "module");
    this.package.addField("main", "index.ts");
    this.package.addField("types", "index.ts");
    this.package.addField("exports", {
      ".": "./index.ts",
      "./package.json": "./package.json",
    });
    applyTasks(this, options.tasks ?? {});
    if (options.viteConfig ?? false) emitViteConfig(this);
    lockPackageJson(this);
    initDBXToolsProject(this, options);
  }

  public packageNameFor(relPath: string): string {
    return npmNameOf(this.scope, relPath);
  }
}

/**
 * Regenerates every package's root `index.ts` barrel after synth - "barrels on
 * resynth" for the plain `projen` path. projen only runs `postSynthesize` when
 * `PROJEN_DISABLE_POST` is unset, so this is skipped during the watcher's fast
 * `runSynth` (which sets it); there barrels are rebuilt explicitly.
 */
class GeneratedBarrels extends Component {
  public override postSynthesize(): void {
    generateBarrels();
  }
}

/** A project name resolved from options, else auto-detected (git remote/folder). */
function resolveIdentity(options: { name?: string; scope?: string }): {
  name: string;
  scope: string;
} {
  const name = options.name && options.name.length ? options.name : projectName();
  const rawScope = options.scope && options.scope.length ? options.scope : name;
  return { name, scope: rawScope.replace(/^@/, "") };
}

/**
 * A devDep entry that keeps the engine itself resolvable for the *next* synth (a
 * consumer's `.projenrc.ts` imports the classes from it). Resolved from the
 * engine's OWN nearby `package.json`; `undefined` when running as plain in-repo
 * SOURCE (not under a `node_modules` segment). Reuses whatever specifier the
 * consumer already has for it rather than computing one.
 */
function engineSelfDependency(project: javascript.NodeProject): string | undefined {
  const enginePkgJson = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  if (!toPosix(enginePkgJson).includes("/node_modules/")) return undefined;
  let name: string;
  let version: string;
  try {
    ({ name, version } = JSON.parse(readFileSync(enginePkgJson, "utf8")));
  } catch {
    return undefined;
  }

  const consumerPkgJson = join(resolve(project.outdir), "package.json");
  try {
    const consumer = JSON.parse(readFileSync(consumerPkgJson, "utf8"));
    const existing = consumer.devDependencies?.[name] ?? consumer.dependencies?.[name];
    if (existing) return `${name}@${existing}`;
  } catch {
    // No existing package.json (or no entry) - fall through to a computed pin.
  }
  return `${name}@^${version}`;
}

/** True if `key` matches a discovered package by candidate / relPath / memberPath / glob. */
function tagPathMatches(key: string, p: DiscoveredPackage): boolean {
  if (p.tagCandidates.includes(key)) return true;
  if (key === p.relPath || key === p.memberPath) return true;
  if (key.includes("*")) {
    const re = new RegExp(`^${key.split("*").map(escapeRegExp).join(".*")}$`);
    return re.test(p.relPath) || re.test(p.memberPath) || p.tagCandidates.some((c) => re.test(c));
  }
  return false;
}

/** Resolve a discovered package's tags from the `tagPaths` map (union of matches). */
function resolveTags(p: DiscoveredPackage, tagPaths: Record<string, string[]>): string[] {
  const tags: string[] = [];
  for (const [key, value] of Object.entries(tagPaths)) {
    if (tagPathMatches(key, p)) {
      for (const tag of value) if (!tags.includes(tag)) tags.push(tag);
    }
  }
  return tags;
}

/** Register the native projen tasks on the monorepo root. */
function registerRootTasks(project: javascript.NodeProject): void {
  const set = (name: string, exec: string): void => {
    const task = project.tasks.tryFind(name) ?? project.addTask(name);
    task.reset(exec);
  };
  set("barrels", "pnpm dbxtools barrels");
  set("typecheck", "pnpm dbxtools typecheck");
  set("openapi", "pnpm dbxtools openapi");
  // `sync`: keep the tree in sync while editing by running the watches
  // concurrently - `projen --watch` re-synths on `.projenrc.ts` changes (barrels
  // regenerate via the post-synth component), while `dbxtools watch` re-synths on
  // package add/remove and rebuilds barrels on source edits (no re-synth). No
  // env-var/postSynthesize watcher.
  set(
    "sync",
    'concurrently -k -n projen,workspace "pnpm exec projen --watch" "pnpm dbxtools watch"',
  );
}

/**
 * Shared init both classes call at the end of their constructor. Only the tree
 * ROOT does anything: it attaches the projenrc runner, root devDeps/fields,
 * `pnpm-workspace.yaml`, shared config, tasks, gitignore/`annotateGenerated`,
 * scans + appends children, applies the built-in tag mixins across the subtree
 * (via `project.with`), and adds the barrels-on-synth component. Non-root projects
 * return immediately.
 */
function initDBXToolsProject(project: javascript.NodeProject & IDBXToolsProject, options: DBXToolsCommonOptions): void {
  if (project.parent) return; // only a ROOT configures the workspace


  // NodeProject has no built-in TS projenrc support (unlike TypeScriptProject), so
  // wire `.projenrc.ts` through the tsx runner - this also populates the `default`
  // task that `pnpm exec projen` (and `projen --watch`) run.
  new typescript.ProjenrcTs(project, { runner: typescript.TypeScriptRunner.tsx() });

  const selfDep = engineSelfDependency(project);
  project.addDevDeps(
    ...(selfDep ? [selfDep] : []),
    "concurrently@^9.1.0",
    "tsx@^4.23.0",
    "typescript@^5.9.3",
    "@types/node@^24.6.0",
  );
  project.package.addField("type", "module");
  project.package.addField("private", true);
  lockPackageJson(project);

  files.tsconfigBase(project);
  files.tsconfigRoot(project);
  files.prettierConfig(project);
  files.prettierIgnore(project);
  files.vscodeTasks(project);
  files.vscodeSettings(project);
  files.vscodeExtensions(project);
  registerRootTasks(project);

  project.gitignore.addPatterns(
    ".DS_Store",
    "dist",
    "**/dist",
    "*.tsbuildinfo",
    "node_modules/.cache",
    ".env",
    "tmp",
  );
  const roots = options.workspacePackageRoots ?? DEFAULT_WORKSPACE_PACKAGE_ROOTS;
  for (const root of roots) {
    project.annotateGenerated(`/${root}/**/index.ts`);
    project.annotateGenerated(`/${root}/openapi/**`);
  }

  // Known tag names (each keys a WORKSPACE_TAG_MIXINS entry), minus any disabled.
  const disabled = new Set(options.disableWorkspaceTags ?? []);
  const tagNames = (Object.keys(WORKSPACE_TAG_MIXINS) as WorkspaceTag[]).filter(
    (t) => !disabled.has(t),
  );
  // path token/relPath/glob -> tag(s). Default: identity over the enabled tag names;
  // any workspacePackageTagPaths entries AUGMENT that. A `""`/`"."` key tags the root.
  const tagPaths: Record<string, string[]> = {
    ...Object.fromEntries(tagNames.map((k) => [k, [k]])),
    ...(options.workspacePackageTagPaths ?? {}),
  };

  // Already-attached subprojects, keyed by repo-relative member path.
  const rootAbs = resolve(project.outdir);
  const existing = new Map<string, javascript.NodeProject>();
  for (const sub of project.subprojects) {
    if (sub instanceof javascript.NodeProject) {
      existing.set(toPosix(relative(rootAbs, sub.outdir)), sub);
    }
  }

  // Discover + append a child per src-bearing folder. A root encapsulating an
  // already-attached project doesn't re-create it, it just unions the tags in. The
  // agnostic floor is set in the child's constructor; per-tag deps/tsconfig come from
  // the WORKSPACE_TAG_MIXINS applied across the subtree below.
  for (const p of scanPackages(rootAbs, roots)) {
    const tags = resolveTags(p, tagPaths);
    const found = existing.get(p.memberPath);
    if (found) {
      if (isDBXToolsProject(found)) found.dbxToolsConfig.appendTag(...tags);
      else addWorkspacePackageTags(found, tags);
      continue;
    }
    new DBXToolsTypeScriptProject({
      parent: project,
      outdir: p.memberPath,
      name: project.packageNameFor(p.relPath),
      dbxToolsConfig: { tags },
    });
  }

  // The root project may itself carry tags (via a `""`/`"."` tag-path key).
  const rootTags = [...new Set([...(tagPaths[""] ?? []), ...(tagPaths["."] ?? [])])];
  if (rootTags.length) project.dbxToolsConfig.appendTag(...rootTags);

  // Apply the base per-tag mixins, then the opt-in default extras, across the whole
  // subtree now that every child exists (`construct.with` captures the tree at call
  // time). User mixins run afterward via the caller's own `project.with(...)`.
  const tagMixins = tagNames.map((t) => WORKSPACE_TAG_MIXINS[t]);
  const mixins = [...tagMixins, ...resolveDefaultTagMixins(options.defaultTagMixins ?? "all")];
  if (mixins.length) project.with(...mixins);

  new GeneratedBarrels(project);
}

/** True if `p` is one of the DBXTools project classes (has the tag surface). */
function isDBXToolsProject(p: unknown): p is IDBXToolsProject {
  return p instanceof DBXToolsNodeProject || p instanceof DBXToolsTypeScriptProject;
}
