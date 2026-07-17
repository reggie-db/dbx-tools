/**
 * The dbx-tools project surface plus workspace package tooling: the single
 * {@link DBXToolsProject} interface, the projen Node/TypeScript project classes,
 * naming, guards, manifest fields, and the shared root init.
 *
 * {@link DBXToolsNodeProject} (monorepo root) and {@link DBXToolsTypeScriptProject}
 * (a package, or a standalone compiling root) both implement {@link DBXToolsProject}.
 */
import { string, type OneOrMany } from "@dbx-tools/shared-core";
import { ignore, match } from "@dbx-tools/path";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Component, IgnoreFile, Project, type TaskOptions, javascript, typescript } from "projen";
import { ReleaseTrigger } from "projen/lib/release";
import { generateBarrels } from "./barrels";
import { generateCodegen } from "./codegen";
import { DBXToolsConfig, type DBXToolsConfigOptions } from "./dbx-tools-config";
import { resolvePkgRoot } from "./engine-root";
import { DBXToolsPNPMWorkspace, type DBXToolsPNPMWorkspaceOptions } from "./pnpm-workspace";
import { DBXToolsRelease } from "./release";
import { AGNOSTIC_COMPILER_OPTIONS, WORKSPACE_TAG_MIXINS, type WorkspaceTag } from "./tags";
import { DBXToolsRootTsconfig } from "./tsconfig";
import { ViteConfigFile } from "./vite";
import { DBXToolsVsCode } from "./vscode";
import {
  DEFAULT_WORKSPACE_PACKAGE_ROOTS,
  type DiscoveredPackage,
  projectName,
  repositoryUrl,
  scanPackages,
  toPosix,
} from "./workspace";

/**
 * The dbx-tools project surface, backed by projen's Node toolchain. A single
 * interface for both the monorepo root and each package: it carries the
 * `dbxToolsConfig` component plus the npm-naming and root-only file components.
 */
export interface DBXToolsProject extends javascript.NodeProject {
  /** The package's `dbxToolsConfig` component (tags + `package.json` config). */
  readonly dbxToolsConfig: DBXToolsConfig;
  /** npm scope (the `@scope` in `@scope/pkg`), without the leading `@`. */
  readonly scope: string;
  /** Parsed `package.json` `name` (optional scope + unscoped name). */
  readonly packageIdentifier: PackageIdentifier;

  /** The `pnpm-workspace.yaml` file component - only a tree ROOT has one. */
  pnpmWorkspace?: DBXToolsPNPMWorkspace;
  /** Root projenrc tsconfigs - only a tree ROOT has one. */
  rootTsconfig?: DBXToolsRootTsconfig;
  /** Root `.vscode/*` - only a tree ROOT has one. */
  vsCode?: DBXToolsVsCode;
}

/** Parsed npm package identifier: optional scope plus the unscoped package name. */
export class PackageIdentifier {
  public scope?: string;

  public name: string;

  constructor(scope: string | null | undefined, name: string) {
    this.scope = scope || undefined;
    this.name = name;
  }

  /** Replace the scope (leading `@` is optional) and return `this`. */
  public withScope(scope: string): this {
    const normalized = scope.replace(/^@/, "").trim();
    this.scope = normalized || undefined;
    return this;
  }

  /** Replace the unscoped package name and return `this`. */
  public withName(name: string): this {
    this.name = name;
    return this;
  }

  /** Full npm name (`@scope/name` or bare `name`). */
  public get packageName(): string {
    return this.scope ? `@${this.scope}/${this.name}` : this.name;
  }

  public toString(): string {
    return this.packageName;
  }

  /**
   * Parse an npm package name into scope and unscoped segments without rewriting them.
   */
  static parse(value: string): PackageIdentifier | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;

    if (trimmed.startsWith("@")) {
      const slash = trimmed.indexOf("/", 1);
      if (slash === -1) return new PackageIdentifier(trimmed.slice(1), "");
      return new PackageIdentifier(trimmed.slice(1, slash), trimmed.slice(slash + 1));
    }

    const slash = trimmed.indexOf("/");
    if (slash === -1) return new PackageIdentifier(undefined, trimmed);
    return new PackageIdentifier(trimmed.slice(0, slash), trimmed.slice(slash + 1));
  }

  /**
   * Build from ordered path parts. One segment stays bare; multiple become
   * `@<first>/<rest joined by ->`.
   *
   * The leading segment is the npm `@scope`, kebab-cased with
   * {@link string.toSlug} so a multi-word scope survives intact
   * (`dbx-tools` -> `dbx-tools`, not `dbx`/`tools`). Every later path
   * segment is tokenized with {@link string.tokenize}, so nested folders
   * split into their own dash-joined name parts.
   */
  static of(...names: OneOrMany<string>): PackageIdentifier {
    const segments = names.flatMap((part) => part.split("/")).filter(Boolean);
    const scope = segments.length ? string.toSlug(segments[0]!) : "";
    const nameParts = [
      scope,
      ...segments.slice(1).flatMap((segment) => [...string.tokenize(segment)]),
    ].filter(Boolean);
    if (!nameParts.length) throw new Error(`Invalid name: ${names.join(", ")}`);
    if (nameParts.length === 1) return new PackageIdentifier(undefined, nameParts[0]!);
    return new PackageIdentifier(nameParts[0], nameParts.slice(1).join("-"));
  }
}

/** Parsed `package.json` `name` for a projen `NodeProject`. */
export function identifier(project: Project): PackageIdentifier {
  return PackageIdentifier.parse(project.name) ?? new PackageIdentifier(undefined, project.name);
}

/** Root-only `package.json` fields. */
function configureRootPackage(project: javascript.NodeProject): void {
  project.package.addField("type", "module");
  project.package.addField("private", true);
}

/**
 * Lazily-detected, normalized git remote URL (npm `git+https://.../repo.git`
 * form). `null` = not yet probed, `undefined` = probed but no remote. Cached so
 * the whole subtree shares one `git config` lookup.
 */
let detectedRepositoryUrl: string | undefined | null = null;

/** Resolve the repository URL: an explicit override wins, else the cached detection. */
function resolveRepositoryUrl(override?: string): string | undefined {
  if (override && override.length) return override;
  if (detectedRepositoryUrl === null) detectedRepositoryUrl = repositoryUrl();
  return detectedRepositoryUrl;
}

/**
 * Stamp `repository` on a package's manifest so npm provenance can validate the
 * published source (without it, publish fails with E422). A child also carries the
 * monorepo `directory` subpath (its path relative to the root); the root omits it.
 * No-op when no git remote is detected and no `repository` override was supplied.
 * The URL is auto-detected once from `remote.origin.url` (see {@link repositoryUrl}).
 */
function applyRepository(project: javascript.NodeProject, override?: string): void {
  const url = resolveRepositoryUrl(override);
  if (!url) return;
  const root = project.parent ?? project;
  const directory = toPosix(relative(resolve(root.outdir), resolve(project.outdir)));
  project.package.addField("repository", {
    type: "git",
    url,
    ...(directory ? { directory } : {}),
  });
}

/** Inherit a parent's package manager, else pnpm. */
function inheritedPackageManager(
  parent: javascript.NodeProject | undefined,
): javascript.NodePackageManager {
  return parent?.package.packageManager ?? javascript.NodePackageManager.PNPM;
}

/** Override a package's generated tsconfig `compilerOptions` (later-wins per key). */
export function applyCompilerOptions(
  pkg: javascript.NodeProject,
  compilerOptions: javascript.TypeScriptCompilerOptions,
): void {
  if (!(pkg instanceof typescript.TypeScriptProject)) return;
  const file = pkg.tsconfig?.file;
  if (!file) return;
  for (const [key, value] of Object.entries(compilerOptions)) {
    if (value === undefined) continue;
    file.addOverride(`compilerOptions.${key}`, value);
  }
  if (compilerOptions.jsx) pkg.tsconfig?.addInclude("src/**/*.tsx");
}

/** Apply a tag's `tasks` through projen's task system. */
export function applyTasks(pkg: javascript.NodeProject, tasks?: Record<string, TaskOptions>): void {
  if (!tasks) return;
  for (const [name, options] of Object.entries(tasks)) {
    const owned = name === "build" ? pkg.compileTask : pkg.tasks.tryFind(name);
    if (owned) owned.reset(options.exec, options);
    else pkg.addTask(name, options);
  }
}

/**
 * Set a package's `exports` subpath map (whole-field replace, so a later mixin
 * that supplies a fuller surface wins over a tag default). Lets the `cli` / `ui`
 * / `app` tags carry their standard export layout and a package only re-declare
 * `exports` when it deviates.
 */
export function applyExports(
  pkg: javascript.NodeProject,
  exports: Record<string, string>,
): void {
  pkg.package.addField("exports", exports);
}

/** ESM compiler options every Node package shares regardless of tag. */
const SHARED_COMPILER_OPTIONS: javascript.TypeScriptCompilerOptions = {
  module: "ESNext",
  moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
  skipLibCheck: true,
};

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
    devDeps: ["@types/node@^24.6.0"],
    ...(isRoot
      ? {
        prettier: true,
        prettierOptions: {
          settings: PRETTIER_SETTINGS,
          ignoreFile: true,
          ignoreFileOptions: { ignorePatterns: [...ignore.ignorePatterns()] },
        },
      }
      : {}),
    ...options,
    ...copiedGitIgnoreOptions(options),
  };
}

/**
 * `gitIgnoreOptions` with its `ignorePatterns` array CLONED, for handing to a
 * projen `Project` constructor: projen's IgnoreFile ALIASES the array it is given
 * (every later addPatterns call mutates it), so the throwaway default-laden
 * `.gitignore` gets a copy - {@link swapChildGitignore} re-reads the caller's
 * pristine array to seed a child's fresh one. Spread AFTER `...options`.
 */
function copiedGitIgnoreOptions(
  options: DBXToolsProjectOptions,
): Pick<javascript.NodeProjectOptions, "gitIgnoreOptions"> {
  if (!options.gitIgnoreOptions?.ignorePatterns) return {};
  return {
    gitIgnoreOptions: {
      ...options.gitIgnoreOptions,
      ignorePatterns: [...options.gitIgnoreOptions.ignorePatterns],
    },
  };
}

/**
 * The engine's `TypeScriptProject` defaults - a superset of {@link defaultProjectOptions}.
 * A DBXTools TS project can itself be the ROOT (a standalone compiling root), so the
 * same parent-based root/child logic applies; this just layers on tsx/typescript and
 * disables sample code.
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
    ...copiedGitIgnoreOptions(options),
  };
}

// Pinned to match the subproject defaults so pnpm resolves a single tsx/typescript
// across the workspace (a bare name -> `*` could pull a second, newer major).
const DEV_DEPS_ROOT: string[] = ["tsx@^4.23.0", "typescript@^5.9.3"];

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
   * Leading path segment(s) dropped from a discovered package's relative path
   * before its npm name is derived, so a tier folder doesn't become a name
   * prefix. E.g. with the default `"node"`, `workspaces/node/path` names as
   * `@<scope>/path` instead of `@<scope>/node-path` (its `node` TAG still
   * derives from the path). One or many segment names; a segment is only
   * stripped when it is the FIRST segment of the relative path. Pass `[]` to
   * disable. Defaults to `"node"`.
   */
  readonly omitRelativePrefix?: OneOrMany<string>;
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
  /**
   * Extra repo-root paths that trigger a full re-synth during `sync --watch`
   * (alongside `.projenrc.ts`). Repo-relative, e.g. `".example.projenrc.ts"`.
   */
  readonly syncResynthPaths?: readonly string[];
}

/** Options for {@link DBXToolsTypeScriptProject} (a package, or a compiling root). */
export interface DBXToolsTypeScriptProjectOptions
  extends Partial<typescript.TypeScriptProjectOptions>, DBXToolsProjectOptions {
  /** Emit a projen-owned `vite.config.ts`. */
  readonly viteConfig?: boolean;
}

/**
 * A monorepo root. Scans `workspacePackageRoots` and appends a
 * {@link DBXToolsTypeScriptProject} per `src`-bearing folder, then emits the
 * shared config, tasks, `pnpm-workspace.yaml`, and barrels-on-synth.
 */
export class DBXToolsNodeProject extends javascript.NodeProject implements DBXToolsProject {
  readonly scope: string;
  readonly dbxToolsConfig: DBXToolsConfig;
  pnpmWorkspace?: DBXToolsPNPMWorkspace;
  rootTsconfig?: DBXToolsRootTsconfig;
  vsCode?: DBXToolsVsCode;

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
    this.dbxToolsConfig = new DBXToolsConfig(this, options);
    initProject(this, options);
  }

  public override preSynthesize(): void {
    super.preSynthesize();
    preSynthesizeProject(this);
  }

  public get packageIdentifier(): PackageIdentifier {
    return identifier(this);
  }
}

/**
 * A single workspace package (usually created by a root's scan), or a standalone
 * compiling root. The agnostic tsconfig floor is applied at construction; the
 * source-first package fields (`main`/`types`/`exports` -> `index.ts`) and an
 * optional `vite.config.ts` are applied after. Per-tag deps/tsconfig arrive later
 * via the {@link WORKSPACE_TAG_MIXINS} the root applies.
 */
export class DBXToolsTypeScriptProject
  extends typescript.TypeScriptProject
  implements DBXToolsProject {
  readonly scope: string;
  readonly dbxToolsConfig: DBXToolsConfig;
  pnpmWorkspace?: DBXToolsPNPMWorkspace;
  rootTsconfig?: DBXToolsRootTsconfig;
  vsCode?: DBXToolsVsCode;

  constructor(options: DBXToolsTypeScriptProjectOptions) {
    const { name, scope } = resolveIdentity(options);
    const parent = options?.parent;
    const packageManager =
      options.packageManager ??
      inheritedPackageManager(parent instanceof javascript.NodeProject ? parent : undefined);

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
    this.dbxToolsConfig = new DBXToolsConfig(this, options);
    // Source-first entry: point the package at its package-ROOT `index.ts` barrel
    // so workspace packages resolve each other's `@scope/pkg` imports to source.
    this.package.addField("type", "module");
    this.package.addField("main", "index.ts");
    this.package.addField("types", "index.ts");
    this.package.addField("exports", {
      ".": "./index.ts",
      "./package.json": "./package.json",
    });
    this.testTask.exec("tsx --test 'test/**/*.test.ts'");
    if (options.viteConfig ?? false) new ViteConfigFile(this);
    initProject(this, options);
  }

  public override preSynthesize(): void {
    super.preSynthesize();
    preSynthesizeProject(this);
  }

  public get packageIdentifier(): PackageIdentifier {
    return identifier(this);
  }
}

/**
 * Regenerates the repo's generated source after synth: first the codegen
 * modules (ts-to-zod schemas from each `codegen`-declaring package's upstream
 * `.d.ts`), then every package's root `index.ts` barrel - so a freshly
 * generated module is namespaced into its barrel in the same pass. This is the
 * "generate on resynth" path for plain `projen`; codegen inputs (SDK `.d.ts`)
 * change rarely, so a synth-time regen is enough and there's no separate watch.
 *
 * projen only runs `postSynthesize` when `PROJEN_DISABLE_POST` is unset, so this
 * is skipped during the watcher's fast `runSynth` (which sets it); there barrels
 * are rebuilt explicitly. It also runs after `NodeProject`'s own post-synth
 * install, so codegen's `node_modules/...` inputs resolve.
 */
class GeneratedSource extends Component {
  public override postSynthesize(): void {
    generateCodegen();
    generateBarrels();
  }
}

/** Default leading path segment stripped from a package's name (not its tag). */
const DEFAULT_OMIT_RELATIVE_PREFIX = ["node"];

/** Normalize the {@link DBXToolsProjectOptions.omitRelativePrefix} option to a slug list. */
function resolveOmitRelativePrefix(option: OneOrMany<string> | undefined): string[] {
  const raw = option === undefined ? DEFAULT_OMIT_RELATIVE_PREFIX : option;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((segment) => string.toSlug(segment)).filter(Boolean);
}

/**
 * Derive a package's npm name from its scope + relative path, dropping a leading
 * `omitPrefixes` segment first (so a tier folder like `node/` doesn't become a
 * name prefix). The full `relPath` is still used elsewhere for tags.
 */
function packageNameFor(scope: string, relPath: string, omitPrefixes: string[]): string {
  const segments = relPath.split("/").filter(Boolean);
  if (segments.length > 1 && omitPrefixes.includes(string.toSlug(segments[0]!))) {
    segments.shift();
  }
  return PackageIdentifier.of(scope, segments.join("/")).packageName;
}

/**
 * Resolve `{ name, scope }` from options. `name` is `options.name`, else
 * auto-detected (git remote/folder). `scope` is `options.scope`, else the name;
 * either way it is parsed through {@link PackageIdentifier} so a scoped value
 * (`@dbx-tools` or a full `@dbx-tools/root` name) yields the bare scope `dbx-tools`.
 */
function resolveIdentity(options: { name?: string; scope?: string }): {
  name: string;
  scope: string;
} {
  const name = options.name && options.name.length ? options.name : projectName();
  const rawScope = options.scope && options.scope.length ? options.scope : name;
  const identifier = PackageIdentifier.parse(rawScope);
  return { name, scope: identifier?.scope ?? identifier?.name ?? rawScope };
}

/**
 * A devDep entry that keeps the engine itself resolvable for the *next* synth (a
 * consumer's `.projenrc.ts` imports the classes from it). Resolved from the
 * engine's OWN nearby `package.json`; `undefined` when running as plain in-repo
 * SOURCE (not under a `node_modules` segment). Reuses whatever specifier the
 * consumer already has for it rather than computing one.
 */
function engineSelfDependency(project: javascript.NodeProject): string | undefined {
  const enginePkgJson = join(resolvePkgRoot(), "package.json");
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
  // Otherwise treat the key as a glob against the same targets.
  const isMatch = match.toPathMatcher(key);
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
  applyTasks(project, {
    barrels: { exec: taskScript(project, "barrels.ts") },
    openapi: { exec: taskScript(project, "openapi.ts") },
    clean: { exec: taskScript(project, "clean.ts"), receiveArgs: true },
    // `receiveArgs` forwards `--watch`, so `pnpm exec projen sync --watch` syncs once
    // then starts the single node-path watcher loop.
    sync: { exec: taskScript(project, "sync.ts"), receiveArgs: true },
  });
}

/**
 * `tsx <rel>/tasks/<script>` command for a projen task, relative to `project.outdir`.
 * Resolves the engine's `tasks/` dir off its installed package root (via
 * {@link resolvePkgRoot}), so it works both in-repo and when the engine is a
 * dependency in a consumer's `node_modules` - no filesystem walking.
 */
export function taskScript(project: javascript.NodeProject, script: string, args = ""): string {
  const scriptPath = join(resolvePkgRoot(), "tasks", script);
  const rel = toPosix(relative(resolve(project.outdir), scriptPath));
  return args ? `tsx ${rel} ${args}` : `tsx ${rel}`;
}

/**
 * Shared init both classes call at the end of their constructor. Only the tree
 * ROOT does anything: it attaches the projenrc runner, root devDeps/fields,
 * `pnpm-workspace.yaml`, shared config, tasks, gitignore/`annotateGenerated`,
 * scans + appends children, applies the built-in tag mixins across the subtree
 * (via `project.with`), and adds the barrels-on-synth component. Non-root projects
 * only swap in a fresh custom-patterns-only `.gitignore` and return.
 */
function initProject(
  project: DBXToolsNodeProject | DBXToolsTypeScriptProject,
  options: DBXToolsProjectOptions,
): void {
  // projen's GithubProject seeds a `# replace this` SampleReadme on every
  // project. READMEs are hand-written and owned outside projen, so drop the
  // generated one (and never mark it read-only) - both root and child.
  project.tryRemoveFile("README.md");

  if (project.parent) {
    project.package.file.readonly = true;
    // Stamp `repository` (with this package's `directory` subpath) so a published
    // package passes npm provenance validation.
    applyRepository(project, options.repository);
    // Only a ROOT configures the workspace; a child just swaps its default-laden
    // `.gitignore` for a fresh one that carries package-specific patterns only.
    swapChildGitignore(project, options);
    return;
  }
  project.package.file.readonly = false;

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
  configureRootPackage(project);
  // Root carries the bare `repository` (no `directory`); children add their subpath.
  applyRepository(project, options.repository);

  if (options.syncResynthPaths?.length) {
    project.dbxToolsConfig.syncResynthPaths = [...options.syncResynthPaths];
  }

  project.pnpmWorkspace = new DBXToolsPNPMWorkspace(project, options);
  project.rootTsconfig = new DBXToolsRootTsconfig(project);
  project.vsCode = new DBXToolsVsCode(project);

  registerRootTasks(project);
  if (options.prettier || project.prettier) {
    const formatTask = project.tasks.tryFind("format") ?? project.addTask("format");
    formatTask.prependExec("prettier . --write", { receiveArgs: true });
  }

  project.gitignore.addPatterns(...[...ignore.ignorePatterns()]);
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
  // Generated read-only outputs (barrels, openapi clients, vite configs). ESLint
  // --fix cannot rewrite them; they are stamped by the barrel generator / dbxtools / projen.
  for (const root of roots) {
    eslint.addIgnorePattern(`${root}/openapi/**`);
    eslint.addIgnorePattern(`${root}/**/index.ts`);
  }
  eslint.addIgnorePattern("**/vite.config.ts");
  eslint.addRules({
    "import/no-relative-packages": "error",
    // Monorepo tooling legitimately uses devDeps (typescript, tsx, projen) in src.
    "import/no-extraneous-dependencies": [
      "error",
      { devDependencies: true, optionalDependencies: false, peerDependencies: true },
    ],
    "@typescript-eslint/no-shadow": "off",
    "no-bitwise": "off",
    "@typescript-eslint/member-ordering": "off",
  });
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
  const omitPrefixes = resolveOmitRelativePrefix(options.omitRelativePrefix);

  // path token/relPath/glob -> tag(s). Default: identity over the enabled tag names;
  // any workspacePackageTagPaths entries AUGMENT that. A `""`/`"."` key tags the root.
  const tagPaths: Record<string, string[]> = {
    ...Object.fromEntries(enabledTagMixins.map((k) => [k, [k]])),
    ...(options.workspacePackageTagPaths ?? {}),
  };

  // Already-attached subprojects, keyed by repo-relative member path.
  const rootAbs = resolve(project.outdir);
  const existing = new Map<string, DBXToolsProject>();
  for (const sub of project.subprojects) {
    if (sub instanceof DBXToolsNodeProject || sub instanceof DBXToolsTypeScriptProject) {
      existing.set(toPosix(relative(rootAbs, sub.outdir)), sub);
    }
  }

  // Discover + append a child per src-bearing folder. A root encapsulating an
  // already-attached project doesn't re-create it, it just unions the tags in. The
  // agnostic floor is set in the child's constructor; per-tag deps/tsconfig come from
  // the WORKSPACE_TAG_MIXINS applied across the subtree below.
  for (const p of scanPackages(rootAbs, roots)) {
    const tags = [...new Set([...p.tagCandidates, ...resolveTags(p, tagPaths)])];
    const found = existing.get(p.memberPath);
    if (found) {
      found.dbxToolsConfig.tags.push(...tags);
      continue;
    }
    new DBXToolsTypeScriptProject({
      parent: project,
      outdir: p.memberPath,
      name: packageNameFor(project.scope, p.relPath, omitPrefixes),
      tags,
    });
  }

  // The root project may itself carry tags (via a `""`/`"."` tag-path key).
  const rootTags = [...new Set([...(tagPaths[""] ?? []), ...(tagPaths["."] ?? [])])];
  if (rootTags.length) project.dbxToolsConfig.tags.push(...rootTags);

  // Apply per-tag mixins across the whole subtree now that every child exists
  // (`construct.with` captures the tree at call time). User mixins run afterward
  // via the caller's own `project.with(...)`.
  if (enabledTagMixins.length) {
    project.with(...enabledTagMixins.map((t) => WORKSPACE_TAG_MIXINS[t]));
  }

  new GeneratedSource(project);
  // The `bump` task (compute next version + commit + tag + push) is useful on
  // any root; the actual publish is a tag-triggered GitHub workflow the caller
  // authors. Independent of projen's own `release` component.
  new DBXToolsRelease(project as DBXToolsNodeProject, {
    tagPrefix: options.releaseTagPrefix,
  });
}

/**
 * A child's `.gitignore`, tracking whether any pattern was ever added so an
 * untouched (empty) file can be dropped at presynth. `exclude`/`include` and
 * constructor `ignorePatterns` all funnel through {@link addPatterns}, so the flag
 * sees every route - but seed patterns must be added AFTER construction (see
 * {@link swapChildGitignore}) because class fields initialize after `super()`.
 */
class ChildGitignore extends IgnoreFile {
  /** True once any pattern landed (custom patterns => the file is emitted). */
  public hasPatterns = false;

  public override addPatterns(...patterns: string[]): void {
    if (patterns.length) this.hasPatterns = true;
    super.addPatterns(...patterns);
  }
}

/**
 * Swap a CHILD's default `.gitignore` - pre-populated by `NodeProject` with the
 * same defaults the root already carries (git applies the root's file to the whole
 * tree) - for a FRESH {@link ChildGitignore}. Caller-supplied patterns
 * (`gitignore` / `gitIgnoreOptions.ignorePatterns`) are re-seeded, and later
 * `project.gitignore.addPatterns(...)` calls (tag/user mixins) land here too, so a
 * package CAN carry package-specific ignores without inheriting the root noise.
 * Left empty, the file is dropped by {@link preSynthesizeProject}. Safe because
 * projen only writes gitignore defaults at construction time (`addDefaultGitIgnore`,
 * yarn-berry config), never during synth.
 */
function swapChildGitignore(
  project: javascript.NodeProject,
  options: DBXToolsProjectOptions,
): void {
  project.tryRemoveFile(".gitignore");
  const fresh = new ChildGitignore(project, ".gitignore", {
    ...options.gitIgnoreOptions,
    // Re-added below so the custom-pattern flag sees them (not clobbered by the
    // subclass field initializer running after super()).
    ignorePatterns: undefined,
  });
  const seeds = [...(options.gitignore ?? []), ...(options.gitIgnoreOptions?.ignorePatterns ?? [])];
  if (seeds.length) fresh.addPatterns(...seeds);
  // `Project.gitignore` is readonly only at compile time; rebind it so every
  // subsequent `project.gitignore.*` call reaches the fresh file.
  (project as { gitignore: IgnoreFile }).gitignore = fresh;
}

function preSynthesizeProject(project: javascript.NodeProject): void {
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
    // A child's `.gitignore` survives ONLY when it carries custom patterns (see
    // swapChildGitignore). `.gitattributes` is always dropped - the root's
    // annotateGenerated globs cover the children. Runs once from the root's
    // preSynthesize and again from each child's own; both passes agree, so the
    // second is a no-op.
    const keepGitignore = p.gitignore instanceof ChildGitignore && p.gitignore.hasPatterns;
    for (const path of keepGitignore ? [".gitattributes"] : [".gitignore", ".gitattributes"]) {
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
