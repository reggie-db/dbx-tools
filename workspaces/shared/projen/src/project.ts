/**
 * The two project classes you instantiate, plus the shared init that turns a
 * root into a tag-enforcing pnpm monorepo.
 *
 * - `DBXToolsNodeProject` (monorepo root) and `DBXToolsTypeScriptProject` (a
 *   package, or a standalone compiling root) share `DBXToolsCommonOptions` and
 *   expose {@link IDBXToolsProject}: `scope`/`packageNameFor` plus the nested config
 *   COMPONENTS `dbxToolsConfig` (tags) and `pnpmWorkspace` (root-only). Following
 *   projen's own convention (`project.eslint?.addRules(...)`,
 *   `project.package.addField(...)`), you call methods on those fields directly -
 *   `project.dbxToolsConfig.addTags(...)`, `project.pnpmWorkspace?.addCatalog(...)` -
 *   rather than through delegator methods on the project.
 * - Passing `workspacePackageRoots` makes a ROOT scan those roots and append a
 *   `DBXToolsTypeScriptProject` child per `src`-bearing folder, resolving each
 *   child's tags (path-derived, ∪ `workspacePackageTagPaths`) and scope-based npm
 *   name. Every package gets the agnostic tsconfig floor at construction; per-tag
 *   deps/tsconfig/tasks come from the {@link WORKSPACE_TAG_MIXINS} applied via
 *   `construct.with(...)` across the subtree during the root's construction, and
 *   per-package tweaks are user mixins the caller applies with `project.with(...)`.
 * - The root also emits the shared config (tsconfig base/root, projen's built-in
 *   prettier, vscode, `pnpm-workspace.yaml`), native projen tasks (`barrels`/`openapi`/
 *   `sync`/`clean`), barrels on synth, and `annotateGenerated`. Per-package
 *   type-checking is projen's own `compile` task.
 *
 * Replaces the removed `configureProject()` function.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import picomatch from "picomatch";
import {
  Component,
  Project,
  type TaskOptions,
  type TaskStepOptions,
  javascript,
  typescript,
} from "projen";
import { ReleaseTrigger } from "projen/lib/release";
import { resolveEnginePkgRoot } from "dbx-tools/bin";
import { generateBarrels } from "./barrels";
import * as files from "./files";
import { DBXToolsPNPMWorkspace, type DBXToolsPNPMWorkspaceOptions } from "./pnpm-workspace";
import { DBXToolsRelease } from "./publish";
import { AGNOSTIC_COMPILER_OPTIONS, WORKSPACE_TAG_MIXINS, applyTasks, type WorkspaceTag } from "./tags";
import { emitViteConfig } from "./vite";
import {
  DEFAULT_WORKSPACE_PACKAGE_ROOTS,
  type DiscoveredPackage,
  projectName,
  scanPackages,
  toPosix,
} from "./workspace";
import { ignorePatterns } from "@dbx-tools/shared-file-scan";

/** Shared formatting rules, applied by projen's Prettier on whichever project is root. */
const PRETTIER_SETTINGS: javascript.PrettierSettings = {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  quoteProps: javascript.QuoteProps.ASNEEDED,
  jsxSingleQuote: false,
  trailingComma: javascript.TrailingComma.ALL,
  bracketSpacing: true,
  bracketSameLine: false,
  arrowParens: javascript.ArrowParens.ALWAYS,
  endOfLine: javascript.EndOfLine.LF,
};

/**
 * The engine's opinionated `NodeProject` defaults. A caller's own options override
 * these (they are spread AFTER this). Root-only concerns key off `options.parent`,
 * NOT the class: only the tree ROOT (no parent) turns on projen's built-in Prettier
 * (the `prettier` devDep + `.prettierrc.json` + `.prettierignore`), so a child package
 * inherits the root's config rather than emitting its own. `name`/`defaultReleaseBranch`
 * are resolved/applied by the caller.
 */
function defaultProjectOptions(options: DBXToolsProjectOptions): DBXToolsProjectOptions {
  const isRoot = options.parent === undefined;
  return {
    packageManager: javascript.NodePackageManager.PNPM,
    defaultReleaseBranch: "main",
    projenrcJs: false,
    buildWorkflow: false,
    release: false,
    jest: false,
    github: false,
    npmignoreEnabled: false,
    licensed: false,
    entrypoint: "",
    depsUpgrade: false,
    peerDependencyOptions: { pinnedDevDependency: false },
    addPackageManagerToDevEngines: false,
    devDeps: ["picomatch", "@types/node@^24.6.0"],
    ...(isRoot
      ? {
          prettier: true,
          prettierOptions: {
            settings: PRETTIER_SETTINGS,
            ignoreFile: true,
            ignoreFileOptions: { ignorePatterns: [...ignorePatterns()] },
          },
        }
      : {}),
    ...(isRoot ? {} : { gitIgnoreOptions: {} }),
    ...options,
  };
}

/**
 * The engine's `TypeScriptProject` defaults - a superset of
 * {@link defaultNodeProjectOptions}. A DBXTools TS project can itself be the ROOT (a
 * standalone compiling root), so the same parent-based root/child logic applies; this
 * just layers on tsx/typescript and disables sample code.
 */
function defaultTypeScriptProjectOptions(
  options: DBXToolsTypeScriptProjectOptions,
): DBXToolsTypeScriptProjectOptions {
  const base = defaultProjectOptions(options);
  return {
    ...base,
    sampleCode: false,
    entrypoint: undefined,
    // ESLint is configured once on the ROOT (see initProject) and lints the whole
    // tree, so packages don't emit their own config. A caller can still override.
    eslint: false,
    devDeps: [...(base.devDeps ?? []), "tsx@^4.23.0", "typescript@^5.9.3"],
    ...options,
  };
}

/**
 * Append Node's built-in test runner to projen's `test` task. The glob is resolved
 * at run time by tsx, so packages without tests exit 0 with zero cases; drop files
 * under `test/` matching `*.test.ts` and they run on the next `projen test` with no
 * extra config.
 */
function configureNodeTestTask(pkg: typescript.TypeScriptProject): void {
  pkg.testTask.exec("tsx --test 'test/**/*.test.ts'");
}

// Pinned to match the subproject defaults so pnpm resolves a single tsx/typescript
// across the workspace (a bare name -> `*` could pull a second, newer major).
const DEV_DEPS_ROOT: string[] = ["tsx@^4.23.0", "typescript@^5.9.3"];

/**
 * Build an npm package name from ordered parts. Each part is lowercased and split
 * on `/` and any run of non-`[a-z0-9._-]` chars; the cleaned segments join into an
 * npm name - a single segment stays bare (e.g. `dbx-tools`), while multiple become
 * `@<first>/<rest joined by ->`.
 */
export function npmNameOf(name: string, ...names: string[]): string {
  const nameParts = [name, ...names]
    .flatMap((part) => part.split("/"))
    .flatMap((part) =>
      part
        .toLowerCase()
        .split(/[^a-z0-9._-]+/)
        .map((seg) => seg.replace(/^[._-]+|[._-]+$/g, "")),
    )
    .filter(Boolean);
  if (!nameParts.length) throw new Error(`Invalid name: ${[name, ...names].join(", ")}`);
  if (nameParts.length === 1) return nameParts[0]!;
  return `@${nameParts[0]}/${nameParts.slice(1).join("-")}`;
}

/** Tags recorded per NON-DBXTools project, so more can be unioned in later. */
const RECORDED_TAGS = new WeakMap<Project, string[]>();

/** The (deduped) tags recorded on a non-DBXTools project so far (empty if none). */
export function workspacePackageTagsOf(project: Project): string[] {
  return RECORDED_TAGS.get(project) ?? [];
}

/** Union `tags` into a NON-DBXTools project's recorded `dbxToolsConfig.tags`. */
export function addWorkspacePackageTags(project: javascript.NodeProject, tags: string[]): string[] {
  const merged = [...new Set([...(RECORDED_TAGS.get(project) ?? []), ...tags])];
  RECORDED_TAGS.set(project, merged);
  project.package.addField("dbxToolsConfig", { tags: merged });
  return merged;
}

/** ESM compiler options every package shares regardless of tag. */
export const SHARED_COMPILER_OPTIONS: javascript.TypeScriptCompilerOptions = {
  module: "ESNext",
  moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
  skipLibCheck: true,
};

/** Options for {@link DBXToolsNodeProject} (the monorepo root). */
export interface DBXToolsProjectOptions
  extends
    Partial<javascript.NodeProjectOptions>,
    DBXToolsConfigOptions,
    DBXToolsPNPMWorkspaceOptions {
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
   * Which built-in {@link WORKSPACE_TAG_MIXINS} to apply and seed
   * `workspacePackageTagPaths` identity entries for. Omitted = all; `false` = none;
   * a list = only those tags.
   */
  readonly defaultTagMixins?: false | WorkspaceTag[];

  /** Extra projen tasks for this package (name -> `TaskOptions`). */
  readonly tasks?: Record<string, TaskOptions>;
}

/** Options for {@link DBXToolsTypeScriptProject} (a package, or a compiling root). */
export interface DBXToolsTypeScriptProjectOptions
  extends Partial<typescript.TypeScriptProjectOptions>, DBXToolsProjectOptions {
  /** Emit a projen-owned `vite.config.ts`. */
  readonly viteConfig?: boolean;
}

/** Options for the {@link DBXToolsConfig} component (a project's initial `tags`). */
export interface DBXToolsConfigOptions {
  /** Initial tags to record (distinct; order preserved). */
  readonly tags?: string[];
  /**
   * Force the project's `package.json` read-only at synth (projen's per-file
   * `FileBase.readonly`). Persisted to `dbxToolsConfig.lockPackageJson` so it
   * survives re-synths, and applied by {@link DBXToolsConfig.preSynthesize}; `false`
   * leaves it writable.
   * @default true
   */
  readonly lockPackageJson?: boolean;
}

/**
 * Owns the package's `dbxToolsConfig` field in `package.json` - today `tags` and
 * `lockPackageJson`, the per-package source of truth every post-synth command reads
 * back. It resolves each value once (option, else the value persisted in the manifest,
 * else the default) and writes the field directly, so the manifest is the single
 * source of truth across re-synths. `lockPackageJson` (default `true`) is the ONLY
 * switch that forces `package.json` read-only, applied in {@link preSynthesize} so a
 * mixin can still flip it after construction.
 */
export class DBXToolsConfig extends Component {
  private _lockPackageJson: boolean = true;
  private _tags: readonly string[] = [];

  constructor(
    readonly project: javascript.NodeProject,
    options: DBXToolsConfigOptions = {},
  ) {
    super(project);
    if (options.lockPackageJson !== undefined) this.lockPackageJson = options.lockPackageJson;
    if (options.tags !== undefined) this.writeTags(options.tags);
  }

  /** Whether this project's `package.json` is forced read-only at synth. */
  public get lockPackageJson(): boolean {
    return this._lockPackageJson;
  }

  public set lockPackageJson(value: boolean) {
    this._lockPackageJson = value;
    this.write();
  }

  /** The distinct tags on `package.json` `dbxToolsConfig.tags` (empty if unset). */
  public get tags(): readonly string[] {
    return this._tags;
  }

  /** Add tags at the end, keeping the list distinct (incoming moved to the end). */
  public addTags(...tags: string[]): void {
    if (tags.length === 0) return;
    const incoming = [...new Set(tags)];
    this.writeTags([...this._tags.filter((t) => !incoming.includes(t)), ...incoming]);
  }

  /** Add tags at the front, keeping the list distinct (incoming moved to the front). */
  public prependTags(...tags: string[]): void {
    if (tags.length === 0) return;
    this.writeTags([...tags, ...this._tags]);
  }

  /**
   * The single point that actually locks `package.json`: at synth, honoring the
   * resolved {@link lockPackageJson} (default `true`) so a value set via option OR a
   * post-construction mixin is respected. Only an explicit `false` leaves projen's
   * default (writable).
   */
  public override preSynthesize(): void {
    if (this.lockPackageJson) {
      this.project.package.file.readonly = true;
    }
  }

  private writeTags(tags: string[]): void {
    this._tags = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    this.write();
  }

  /** Write `lockPackageJson`/`tags` back to the `dbxToolsConfig` field. */
  private write(): void {
    this.project.package.addField("dbxToolsConfig", {
      ...(this._lockPackageJson === false ? { lockPackageJson: false } : {}),
      ...(this._tags.length > 0 ? { tags: this._tags } : {}),
    });
  }
}

/**
 * The DBXTools-specific surface both project classes expose (used by the shared
 * init + mixins): the project's `scope`/`packageNameFor`, plus the nested config
 * COMPONENTS accessed as fields (projen-style, like `project.eslint`). Tagging and
 * the pnpm surface live on those components - {@link DBXToolsConfig} implements
 * {@link ITagging}, {@link DBXToolsPNPMWorkspace} implements {@link IPnpmWorkspace} -
 * so callers use `project.dbxToolsConfig.addTags(...)` /
 * `project.pnpmWorkspace?.addCatalog(...)` directly, not project-level delegators.
 */
export interface IDBXToolsProject extends javascript.NodeProject {
  /** The npm scope for generated package names (no leading `@`). */
  readonly scope: string;
  /** The component that owns `package.json` `dbxToolsConfig` (tags live here). */
  readonly dbxToolsConfig: DBXToolsConfig;
  /** The `pnpm-workspace.yaml` file component - only a tree ROOT has one. */
  readonly pnpmWorkspace?: DBXToolsPNPMWorkspace;
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

  constructor(options: DBXToolsProjectOptions = {}) {
    const { name, scope } = resolveIdentity(options);
    const releaseDefaults =
      options.release && options.releaseTrigger === undefined
        ? { releaseTrigger: ReleaseTrigger.tagged({ tags: ["v*"] }) }
        : {};
    super({
      ...defaultProjectOptions(options),
      ...releaseDefaults,
      name,
    });

    this.scope = scope;
    // `options` extends both component option bags, so it flows straight in.
    this.dbxToolsConfig = new DBXToolsConfig(this, options);
    this.pnpmWorkspace = new DBXToolsPNPMWorkspace(this, options);
    initProject(this, options);
  }

  public override preSynthesize(): void {
    super.preSynthesize();
    preSynthesizeProject(this);
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
export class DBXToolsTypeScriptProject
  extends typescript.TypeScriptProject
  implements IDBXToolsProject
{
  readonly scope: string;
  readonly dbxToolsConfig: DBXToolsConfig;
  readonly pnpmWorkspace?: DBXToolsPNPMWorkspace;

  constructor(options: DBXToolsTypeScriptProjectOptions) {
    const { name, scope } = resolveIdentity(options);
    const parent = options?.parent;
    const packageManager =
      options.packageManager ??
      (parent instanceof javascript.NodeProject
        ? parent.package.packageManager
        : javascript.NodePackageManager.PNPM);

    super({
      ...defaultTypeScriptProjectOptions(options),
      name: options.name ?? name,
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
    // `options` extends both component option bags, so it flows straight in.
    this.dbxToolsConfig = new DBXToolsConfig(this, options);
    // Only a tree ROOT emits `pnpm-workspace.yaml`; a child package has none (like
    // projen's optional `project.eslint`). `parent` is readonly once super() ran, so
    // this root-vs-child decision is fixed here - the component never re-checks it.
    this.pnpmWorkspace = this.parent ? undefined : new DBXToolsPNPMWorkspace(this, options);

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
    configureNodeTestTask(this);
    if (options.viteConfig ?? false) emitViteConfig(this);
    initProject(this, options);
  }

  public override preSynthesize(): void {
    super.preSynthesize();
    preSynthesizeProject(this);
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
  const enginePkgJson = join(resolveEnginePkgRoot(), "package.json");
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

/** Resolve which {@link WORKSPACE_TAG_MIXINS} keys to apply from `defaultTagMixins`. */
function resolveEnabledTagMixins(selection: false | WorkspaceTag[] | undefined): WorkspaceTag[] {
  if (selection === false) return [];
  if (selection === undefined) {
    return Object.keys(WORKSPACE_TAG_MIXINS) as WorkspaceTag[];
  }
  return selection;
}

/** True if `key` matches a discovered package by candidate / relPath / memberPath / glob. */
function tagPathMatches(key: string, p: DiscoveredPackage): boolean {
  // Fast path: an exact tag candidate or the package's rel/member path.
  if (p.tagCandidates.includes(key) || key === p.relPath || key === p.memberPath) {
    return true;
  }
  // Otherwise treat the key as a glob (picomatch) against the same targets.
  const isMatch = picomatch(key);
  return isMatch(p.relPath) || isMatch(p.memberPath) || p.tagCandidates.some((c) => isMatch(c));
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
  const set = (name: string, exec: string, options?: TaskStepOptions): void => {
    const task = project.tasks.tryFind(name) ?? project.addTask(name);
    task.reset(exec, options);
  };
  set("barrels", taskScript(project, "barrels.ts"));
  set("openapi", taskScript(project, "openapi.ts"));
  set("clean", taskScript(project, "clean.ts"), { receiveArgs: true });
  // `receiveArgs` forwards `--watch`, so `pnpm exec projen sync --watch` syncs once
  // then starts the single file-scan watcher loop.
  set("sync", taskScript(project, "sync.ts"), { receiveArgs: true });
}

/** `tsx <rel>/tasks/<script>` from the monorepo root (works in-repo and installed). */
function taskScript(project: javascript.NodeProject, script: string, args = ""): string {
  const scriptPath = join(resolveTasksDir(), script);
  const rel = toPosix(relative(resolve(project.outdir), scriptPath));
  return args ? `tsx ${rel} ${args}` : `tsx ${rel}`;
}

/** Locate `tasks/` next to the shared-projen package root (source or `lib/` emit). */
function resolveTasksDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, "tasks");
    if (existsSync(candidate)) return candidate;
    dir = join(dir, "..");
  }
  throw new Error("@dbx-tools/shared-projen tasks/ directory not found");
}

/**
 * Shared init both classes call at the end of their constructor. Only the tree
 * ROOT does anything: it attaches the projenrc runner, root devDeps/fields,
 * `pnpm-workspace.yaml`, shared config, tasks, gitignore/`annotateGenerated`,
 * scans + appends children, applies the built-in tag mixins across the subtree
 * (via `project.with`), and adds the barrels-on-synth component. Non-root projects
 * return immediately.
 */
function initProject(
  project: javascript.NodeProject & IDBXToolsProject,
  options: DBXToolsProjectOptions,
): void {
  if (project.parent) return; // only a ROOT configures the workspace

  // NodeProject has no built-in TS projenrc support (unlike TypeScriptProject), so
  // wire `.projenrc.ts` through the tsx runner - this also populates the `default`
  // task that `pnpm exec projen` runs (and that the `sync` watcher invokes to re-synth).
  new typescript.ProjenrcTs(project, {
    runner: typescript.TypeScriptRunner.tsx(),
  });
  // ProjenrcTs wraps that step in `npx -y -p tsx -c "tsx .projenrc.ts"` because the
  // tsx runner declares a `tsx` dependency (so it runs even uninstalled). tsx IS a
  // devDep here, so that wrapper is not merely redundant but harmful: `npx -c` exports
  // `npm_config_call="tsx .projenrc.ts"` into the environment, which every nested
  // `pnpm` inherits and then dies on ("Failed parsing JSON config key call"), failing
  // each subproject's post-synth install; the same `npx`/`npm` process also emits the
  // "Unknown env config" warnings for pnpm's `catalog`/`@jsr:registry`/etc. Reset to a
  // plain exec (tsx resolves from `node_modules/.bin`, which pnpm puts on PATH).
  project.defaultTask?.reset("tsx .projenrc.ts");

  // Only reached on a ROOT (early-returned above otherwise), so the root devDeps
  // always apply; the self-dep is added only when the engine is an installed pkg.
  const selfDep = engineSelfDependency(project);
  if (selfDep) project.addDevDeps(selfDep);
  project.addDevDeps(...DEV_DEPS_ROOT);
  project.package.addField("type", "module");
  project.package.addField("private", true);

  files.tsconfigBase(project);
  files.tsconfigRoot(project);
  files.vscodeTasks(project);
  files.vscodeSettings(project);
  files.vscodeExtensions(project);
  registerRootTasks(project);
  if (options.prettier || project.prettier) {
    const formatTask = project.tasks.tryFind("format") ?? project.addTask("format");
    formatTask.prependExec("prettier . --write", { receiveArgs: true });
  }

  project.gitignore.addPatterns(...[...ignorePatterns()]);
  const roots = options.workspacePackageRoots ?? DEFAULT_WORKSPACE_PACKAGE_ROOTS;
  for (const root of roots) {
    project.annotateGenerated(`/${root}/**/index.ts`);
    project.annotateGenerated(`/${root}/openapi/**`);
  }

  // ESLint lives ONLY on the root and lints every package. `projectService` resolves
  // each file to its own package tsconfig (so type-aware rules work tree-wide), and
  // `import/no-extraneous-dependencies` still checks each file against its nearest
  // package.json. Formatting defers to the root Prettier to avoid rule/formatter
  // conflicts (e.g. quote style).
  const eslint = new javascript.Eslint(project, {
    dirs: [...roots],
    fileExtensions: [".ts", ".tsx"],
    projectService: true,
    prettier: Boolean(project.prettier),
    tsconfigPath: "./tsconfig.json",
  });
  eslint.addRules({ "import/no-relative-packages": "error" });
  eslint.addOverride({
    files: ["**/test/**/*.ts", "**/test/**/*.tsx"],
    // node:test `describe`/`it` return promises by design.
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  });
  // Point the TS import resolver at every package tsconfig, not just the root's
  // (which only includes `.projenrc.ts`), so `import/no-unresolved` resolves
  // cross-package imports.
  const tsResolver = eslint.config?.settings?.["import/resolver"]?.typescript;
  if (tsResolver) {
    tsResolver.project = ["tsconfig.json", ...roots.map((r) => `${r}/**/tsconfig.json`)];
  }

  const enabledTagMixins = resolveEnabledTagMixins(options.defaultTagMixins);

  // path token/relPath/glob -> tag(s). Default: identity over the enabled tag names;
  // any workspacePackageTagPaths entries AUGMENT that. A `""`/`"."` key tags the root.
  const tagPaths: Record<string, string[]> = {
    ...Object.fromEntries(enabledTagMixins.map((k) => [k, [k]])),
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
      if (isDBXToolsProject(found)) found.dbxToolsConfig.addTags(...tags);
      else addWorkspacePackageTags(found, tags);
      continue;
    }
    new DBXToolsTypeScriptProject({
      parent: project,
      outdir: p.memberPath,
      name: project.packageNameFor(p.relPath),
      tags,
    });
  }

  // The root project may itself carry tags (via a `""`/`"."` tag-path key).
  const rootTags = [...new Set([...(tagPaths[""] ?? []), ...(tagPaths["."] ?? [])])];
  if (rootTags.length) project.dbxToolsConfig.addTags(...rootTags);

  // Apply per-tag mixins across the whole subtree now that every child exists
  // (`construct.with` captures the tree at call time). User mixins run afterward
  // via the caller's own `project.with(...)`.
  if (enabledTagMixins.length) {
    project.with(...enabledTagMixins.map((t) => WORKSPACE_TAG_MIXINS[t]));
  }

  new GeneratedBarrels(project);
  if (project.release) new DBXToolsRelease(project as DBXToolsNodeProject);
}

function preSynthesizeProject(project: javascript.NodeProject & IDBXToolsProject): void {
  if (project.prettier) {
    const ignorePatterns = new Set<string>();
    for (const p of projects(project)) {
      p.files.forEach((file) => {
        if (file.readonly) ignorePatterns.add(file.path);
      });
    }
    ignorePatterns.forEach((pattern) => project.prettier!.addIgnorePattern(pattern));
  }
  for (const p of projects(project)) {
    if (!p.parent) continue;
    for (const path of [".gitignore", ".gitattributes"]) {
      if (p.tryRemoveFile(path)) {
        const rootPath = resolve(p.outdir, path);
        if (existsSync(rootPath)) {
          console.log(`Removed ${rootPath} from ${p.name}`);
        }
      }
    }
  }
}

function* projects(project: Project): Generator<Project> {
  yield project;
  for (const sub of project.subprojects) {
    yield* projects(sub);
  }
}

/** True if `p` is one of the DBXTools project classes (has the tag surface). */
function isDBXToolsProject(p: unknown): p is IDBXToolsProject {
  return p instanceof DBXToolsNodeProject || p instanceof DBXToolsTypeScriptProject;
}
