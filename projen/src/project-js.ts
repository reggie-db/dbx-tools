/**
 * The dbx-tools project surface plus package tooling: the single
 * {@link DBXToolsJavaScriptProject} interface, the projen Node/TypeScript project classes,
 * naming, guards, manifest fields, and the shared root init.
 *
 * {@link DBXToolsNodeProject} (monorepo root) and {@link DBXToolsTypeScriptProject}
 * (a package, or a standalone compiling root) both implement {@link DBXToolsJavaScriptProject}.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { ignore, match } from "@dbx-tools/path";
import { object, stringUtils, type OneOrMany } from "@dbx-tools/shared-core";
import { type IConstruct } from "constructs";
import { Component, LogLevel, Project, javascript, typescript } from "projen";
import { JobPermission, type JobStep } from "projen/lib/github/workflows-model";
import type { ReleaseProjectOptions } from "projen/lib/release";
import { generateBarrels } from "./barrels.ts";

import { BUN_APP_OVERRIDES, RootBunfigFile } from "./bun-app.ts";
import { BUN_VERSION } from "./bun-workflow.ts";
import { codegenModulePaths, generateCodegen } from "./codegen.ts";
import { DBXToolsConfig, type DBXToolsConfigOptions } from "./dbx-tools-config.ts";
import { resolvePkgRoot } from "./engine-root.ts";
import * as mixin from "./mixin.ts";
import {
  DEFAULT_PACKAGE_ROOTS,
  type DiscoveredPackage,
  projectName,
  readPackageManifest,
  scanPackages,
  toPosix,
} from "./packages.ts";
import { PnpmWorkspaceState, type DBXToolsPNPMWorkspaceOptions } from "./pnpm-workspace.ts";
import type { DBXToolsProject, DBXToolsProjectOptions as CommonProjectOptions } from "./project.ts";
import { PROJEN_VERSION } from "./projen-version.ts";
import { applyCompiledPublish } from "./publish.ts";
import { generatePythonNodeBindings } from "./python-node-bindings.ts";
import { DBXToolsRelease, type ReleaseDocsOptions } from "./release.ts";
import { AGNOSTIC_COMPILER_OPTIONS, PACKAGE_TAG_MIXINS, type PackageTag } from "./tags.ts";
import { DBXToolsRootTsconfig } from "./tsconfig.ts";
import { configureVsCode } from "./vscode.ts";
import { readWorkspaceVersion, syncWorkspaceManifestVersion } from "./workspace-version.ts";

/**
 * The dbx-tools project surface, backed by projen's Node toolchain. A single
 * interface for both the monorepo root and each package: it carries the
 * `dbxToolsConfig` component plus the npm-naming and root-only file components.
 */
export interface DBXToolsJavaScriptProject extends DBXToolsProject, javascript.NodeProject {
  /** The package's `dbxToolsConfig` component (tags + `package.json` config). */
  readonly dbxToolsConfig: DBXToolsConfig;
  /** npm scope (the `@scope` in `@scope/pkg`), without the leading `@`. */
  readonly scope: string;
  /** Branch that the repository's tag release must match. */
  readonly releaseBranch: string;

  /**
   * The `pnpm-workspace.yaml` catalog / member / build-allowance state - only a
   * tree ROOT has one. The FILE itself is owned by projen's native
   * `javascript.PnpmWorkspaceYaml`; this is the state it renders.
   */
  pnpmWorkspace?: PnpmWorkspaceState;
  /** Root projenrc tsconfigs - only a tree ROOT has one. */
  rootTsconfig?: DBXToolsRootTsconfig;
}

/** Parsed npm package identifier: optional scope plus the unscoped package name. */
export class PackageIdentifier {
  public scope?: string;

  public name: string;

  constructor(scope: string | null | undefined, name: string) {
    this.scope = scope || undefined;
    this.name = name;
  }

  /** Full npm name (`@scope/name` or bare `name`). */
  public get packageName(): string {
    return this.scope ? `@${this.scope}/${this.name}` : this.name;
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
   * {@link stringUtils.toSlug} so a multi-word scope survives intact
   * (`dbx-tools` -> `dbx-tools`, not `dbx`/`tools`). Every later path
   * segment is tokenized with {@link stringUtils.tokenize}, so nested folders
   * split into their own dash-joined name parts.
   */
  static of(...names: OneOrMany<string>): PackageIdentifier {
    const segments = names.flatMap((part) => part.split("/")).filter(Boolean);
    const scope = segments.length ? stringUtils.toSlug(segments[0]!) : "";
    const nameParts = [
      scope,
      ...segments.slice(1).flatMap((segment) => [...stringUtils.tokenize(segment)]),
    ].filter(Boolean);
    if (!nameParts.length) throw new Error(`Invalid name: ${names.join(", ")}`);
    if (nameParts.length === 1) return new PackageIdentifier(undefined, nameParts[0]!);
    return new PackageIdentifier(nameParts[0], nameParts.slice(1).join("-"));
  }
}

/** Parsed `package.json` `name` for a projen `NodeProject`. */
export function identifier(project: Project): PackageIdentifier {
  const name = javascript.NodePackage.of(project)?.packageName ?? project.name;
  return PackageIdentifier.parse(name) ?? new PackageIdentifier(undefined, name);
}

/** Root-only `package.json` fields. */
function configureRootPackage(project: javascript.NodeProject): void {
  project.package.addField("type", "module");
  project.package.addField("private", true);
}

function repositoryOptions(
  options: DBXToolsJavaScriptProjectOptions,
): Pick<javascript.NodeProjectOptions, "repository" | "repositoryDirectory"> {
  const workspaceRoot = resolve(options.parent?.root.outdir ?? options.outdir ?? process.cwd());
  const repository = options.repository ?? projectUtils.repositoryUrl(workspaceRoot, "npm");
  const projectRoot = options.parent
    ? resolve(options.parent.outdir, options.outdir ?? ".")
    : resolve(options.outdir ?? process.cwd());
  const directory = options.parent ? toPosix(relative(workspaceRoot, projectRoot)) : undefined;
  return {
    ...(repository ? { repository } : {}),
    ...(directory ? { repositoryDirectory: directory } : {}),
  };
}

/** Inherit a parent's package manager, else bun. */
function inheritedPackageManager(
  parent: javascript.NodeProject | undefined,
): javascript.NodePackageManager {
  return parent?.package.packageManager ?? javascript.NodePackageManager.BUN;
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
}

/**
 * Add `include` globs to a package's generated tsconfig. The tag defaults cover
 * `src/**` only, so a package that compiles code OUTSIDE `src/` (its root
 * `index.ts` barrel, a `bin/` or `tasks/` tree) needs the extra entries - pair
 * this with a `rootDir: "."` in {@link applyCompilerOptions}.
 */
export function applyIncludes(pkg: javascript.NodeProject, ...includes: string[]): void {
  if (!(pkg instanceof typescript.TypeScriptProject)) return;
  for (const include of includes) pkg.tsconfig?.addInclude(include);
}

/**
 * Set a package's `exports` subpath map (whole-field replace, so a later mixin
 * that supplies a fuller surface wins over a tag default). Lets the `cli` / `ui`
 * / `app` tags carry their standard export layout and a package only re-declare
 * `exports` when it deviates.
 */
export function applyExports(pkg: javascript.NodeProject, exports: Record<string, string>): void {
  pkg.package.addField("exports", exports);
  // Keep the `main`/`types` entry points consistent with the map. A subpath-only
  // surface (the `ui` tag's `./react` + `./styles.css`) has no
  // `.` export, so the constructor's `main`/`types` would keep advertising a
  // root entry that every exports-aware resolver ignores - the contradiction
  // publint reports as "exports is missing the root entrypoint".
  if (!exports["."]) {
    pkg.package.addField("main", undefined);
    pkg.package.addField("types", undefined);
  }
}

/**
 * MERGE extra subpaths onto a package's existing `exports` map (later keys win),
 * preserving whatever a tag default already set. Use when a package just ADDS a
 * subpath - e.g. the CLI tag's `.` + `./package.json` default plus dbx-tools'
 * `./pnpm` - so the two common entries need not be re-listed. Contrast with
 * {@link applyExports}, which replaces the whole field.
 *
 * New subpaths are inserted before the conventional trailing `./package.json`
 * entry when present, so ordering stays `.` -> subpaths -> `./package.json`.
 */
export function addExports(pkg: javascript.NodeProject, exports: Record<string, string>): void {
  const current = (pkg.package.manifest.exports ?? {}) as Record<string, string>;
  const { "./package.json": packageJson, ...rest } = current;
  pkg.package.addField("exports", {
    ...rest,
    ...exports,
    ...(packageJson !== undefined ? { "./package.json": packageJson } : {}),
  });
}

function dependencyName(spec: string): string {
  if (!spec.startsWith("@")) return spec.split("@", 1)[0]!;
  const versionSeparator = spec.indexOf("@", spec.indexOf("/") + 1);
  return versionSeparator < 0 ? spec : spec.slice(0, versionSeparator);
}

/** Add an optional peer and make it available while developing the package. */
export function addOptionalPeer(pkg: javascript.NodeProject, spec: string): void {
  const name = dependencyName(spec);
  const current = object.isRecord(pkg.package.manifest.peerDependenciesMeta)
    ? pkg.package.manifest.peerDependenciesMeta
    : {};
  pkg.addPeerDeps(spec);
  pkg.package.addField("peerDependenciesMeta", {
    ...current,
    [name]: { optional: true },
  });
  pkg.addDevDeps(spec);
}

/** Resolve repository metadata already configured on a Node project. */
export function projectRepositoryUrl(project: javascript.NodeProject): string | undefined {
  const repository = project.package.manifest.repository;
  const configured =
    typeof repository === "string"
      ? repository
      : object.isRecord(repository)
        ? (stringUtils.trimToNull(repository.url) ?? undefined)
        : undefined;
  return configured?.replace(/^git\+/, "").replace(/\.git$/, "");
}

/** Resolve the branch release workflows use for a generated project. */
export function projectReleaseBranch(project: DBXToolsJavaScriptProject): string {
  return project.releaseBranch;
}

/**
 * MERGE entries onto a package's npm `files` allowlist - the only paths that
 * ship in the published tarball. npm always includes `package.json`, `README`,
 * and `LICENSE` on top of whatever is listed, so those are never declared here.
 *
 * The baseline (`index.ts` + `src`, set at construction) is the source-first
 * entry surface the workspace's own `exports` map resolves to. A tag adds what
 * its layout ships outside `src` - the `cli` tag its `bin/` launchers - and
 * {@link applyCompiledPublish} adds `lib/`, which is what the PUBLISHED
 * `exports` resolves to. Source ships alongside the compiled output rather than
 * instead of it: it costs little, and it keeps stack traces and go-to-definition
 * landing on real code for consumers that want it.
 *
 * Everything else the build leaves behind (`test/`, `.projen/`, `tsconfig*`) is
 * unreachable through either map and is deliberately withheld.
 */
export function addPackageFiles(pkg: javascript.NodeProject, ...entries: string[]): void {
  const current = (pkg.package.manifest.files ?? []) as string[];
  pkg.package.addField("files", [...object.sequence(current, entries).distinct()]);
}

/**
 * The automatic subpath map for a package's public top-level TypeScript and CSS
 * files plus directory entrypoints, skipping `_`-prefixed private modules and
 * declaration files.
 *
 * This widens no API surface: the root `index.ts` barrel already re-exports every
 * non-`_` module, so those names are public through `.` either way - the subpaths
 * just add a narrower import path. Deriving the map is what lets a tag carry the
 * whole export layout, instead of each package hand-listing its own modules.
 */
export function srcModuleExports(pkg: javascript.NodeProject): Record<string, string> {
  const srcDir = join(pkg.outdir, "src");
  if (!existsSync(srcDir)) return {};

  const exports: Record<string, string> = {};
  for (const entry of readdirSync(srcDir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.name.startsWith("_")) continue;
    if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      exports[`./${entry.name.replace(/\.tsx?$/, "")}`] = `./src/${entry.name}`;
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".css")) {
      exports[`./${entry.name}`] = `./src/${entry.name}`;
      continue;
    }
    if (!entry.isDirectory()) continue;
    const index = ["index.ts", "index.tsx"].find((file) =>
      existsSync(join(srcDir, entry.name, file)),
    );
    if (index) exports[`./${entry.name}`] = `./src/${entry.name}/${index}`;
  }
  return exports;
}

/**
 * ESM compiler options every package shares regardless of tag.
 *
 * Relative imports in this repo carry their REAL extension (`./http.ts`), which
 * is what lets `tsc` rewrite them to `./http.js` on emit
 * (`rewriteRelativeImportExtensions`) instead of a post-processing pass fixing up
 * the emitted tree. Both flags belong here rather than on the publishing packages
 * only: the specifier style is a property of the SOURCE, so a `ui` package (which
 * publishes source and is excluded from the compiled surface) still has to accept
 * and rewrite it.
 *
 * `jsx` is here for the same reason, and it is NOT a per-tag concern even though
 * only React packages author `.tsx`. Packages resolve each other to SOURCE
 * (`main: index.ts`), so a consumer type-checks its dependency's files under its
 * OWN tsconfig: the moment any package re-exports a `.tsx` module, every package
 * that imports it - however far down the graph, whatever its tag - fails with
 * `TS6142: ... but '--jsx' is not set`. Setting it per consumer is the wrong fix
 * (the consumer does not author JSX and has no way to know a transitive dependency
 * started to), so the floor carries it. The option is inert for a package with no
 * `.tsx` in its graph: it selects how JSX syntax COMPILES and adds no lib, no
 * global, and no type dependency on its own.
 */
const SHARED_COMPILER_OPTIONS: javascript.TypeScriptCompilerOptions & {
  rewriteRelativeImportExtensions: boolean;
} = {
  module: "ESNext",
  moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  rewriteRelativeImportExtensions: true,
  jsx: javascript.TypeScriptJsxMode.REACT_JSX,
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

export { PROJEN_VERSION } from "./projen-version.ts";

/** SPDX license shared by generated JavaScript and Python packages. */
export const LICENSE = "Apache-2.0";

/**
 * The engine's opinionated `NodeProject` defaults. A caller's own options override
 * these (they are spread AFTER this). Root-only concerns key off `options.parent`,
 * NOT the class: only the tree ROOT (no parent) turns on projen's built-in Prettier
 * (the `prettier` devDep + `.prettierrc.json` + `.prettierignore`), so a child package
 * inherits the root's config rather than emitting its own. Projen's informational
 * status messages are hidden by default while task output, warnings, and errors
 * remain visible. `name`/`defaultReleaseBranch` are resolved/applied by the caller.
 */
function defaultProjectOptions(options: DBXToolsJavaScriptProjectOptions) {
  const isRoot = options.parent === undefined;
  return {
    logging: { level: LogLevel.WARN },
    // Bun owns install/run/build/test locally and in CI. projen renders
    // `bun install`/`bunx` and a native `trustedDependencies` field from this.
    // The engine still emits `pnpm-workspace.yaml` itself (see
    // {@link PnpmWorkspaceState}) for the Databricks Apps platform, whose build
    // phase installs with pnpm - so a deployed app keeps its catalog + build
    // allowances even though the local/CI manager is bun.
    packageManager: javascript.NodePackageManager.BUN,
    bunVersion: BUN_VERSION,
    // Pinned rather than left to projen's "latest": this is the co-tested release
    // whose `NodePackage` renders bun's `trustedDependencies` natively. Under bun,
    // projen does NOT create the `pnpm-workspace.yaml` component itself (that call
    // site is gated to pnpm), so the engine constructs it directly ({@link
    // PnpmWorkspaceState}). Floating would let an install cross that boundary
    // silently, so the co-tested version is stated here and bumped deliberately.
    projenVersion: PROJEN_VERSION,
    projenrcJs: false,
    // Every CHILD is a publishable package, so it needs
    // `publishConfig.access: public` - projen renders that from `npmAccess`
    // whenever the value differs from the name's default, and every child here is
    // scoped (`@dbx-tools/*`), whose default is RESTRICTED. Root-only exclusion is
    // deliberate: a root's name is unscoped, so PUBLIC *is* its default and projen
    // would omit the key - except that `npmProvenance` then defaults on and forces
    // the block to render, giving the root a `publishConfig` it does not have
    // today. Provenance is never written to a manifest here (projen only reads it
    // in its own `Publisher`, and `release: false` means none exists). The release
    // workflow opts in per run through `npm_config_provenance`, so local publishes
    // to Verdaccio still work without a CI OIDC provider. See
    // {@link DBXToolsRelease}.
    ...(isRoot || options.publishable === false ? {} : { npmAccess: javascript.NpmAccess.PUBLIC }),
    workflowPackageCache: false,
    // The root build validates the whole workspace and must not also pack every
    // member into unused `dist/js` tarballs. Child projects keep projen's package
    // task so `bun run build` in ONE package remains a complete compile/test/pack
    // operation. Release publication compiles once with filtered root tasks and packs via
    // `bun publish --ignore-scripts` (see {@link applyCompiledPublish}).
    ...(isRoot ? { package: false } : {}),
    jest: false,
    github: false,
    npmignoreEnabled: false,
    entrypoint: "",
    depsUpgrade: false,
    // Bins are declared explicitly via `p.package.addBin(...)`. projen's default
    // auto-detection scans the `bin/` dir and adds every EXECUTABLE file keyed by
    // its filename, so an executable `bin/dbx-tools.ts` becomes a spurious second
    // bin named `dbx-tools.ts` (breaking `pnpm dlx` with ERR_PNPM_DLX_MULTIPLE_BINS).
    autoDetectBin: false,
    peerDependencyOptions: { pinnedDevDependency: false },
    addPackageManagerToDevEngines: false,
    ...(isRoot
      ? {
          prettier: true,
          prettierOptions: {
            settings: PRETTIER_SETTINGS,
            ignoreFile: true,
            ignoreFileOptions: {
              ignorePatterns: [...ignore.ignorePatterns({ test: false, lock: true })],
            },
          },
        }
      : {}),
    ...repositoryOptions(options),
    ...options,
    buildWorkflowOptions: {
      mutableBuild: false,
      permissions: { contents: JobPermission.READ },
      ...options.buildWorkflowOptions,
    },
    release: false,
    ...copiedGitIgnoreOptions(options),
  };
}

/**
 * `gitIgnoreOptions` with its `ignorePatterns` array CLONED, for handing to a
 * projen `Project` constructor: projen's IgnoreFile ALIASES the array it is given
 * and every later `addPatterns` call mutates it. The caller's typed options must
 * remain unchanged while Projen owns and extends the generated ignore file.
 */
function copiedGitIgnoreOptions(
  options: DBXToolsJavaScriptProjectOptions,
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
 * same parent-based root/child logic applies; this just layers on typescript +
 * bun types and disables sample code. No `tsx`: bun runs `.ts` directly.
 */
function defaultTypeScriptProjectOptions(options: DBXToolsTypeScriptProjectOptions) {
  const base = defaultProjectOptions(options);
  return {
    ...base,
    sampleCode: false,
    entrypoint: "index.ts",
    entrypointTypes: "index.ts",
    typescriptVersion: options.typescriptVersion ?? "^5.9.3",
    projenrcTs: false,
    // ESLint is configured once on the ROOT (see initProject) and lints the whole
    // tree, so packages don't emit their own config. A caller can still override.
    eslint: false,
    devDeps: [...(base.devDeps ?? [])],
    ...options,
    ...copiedGitIgnoreOptions(options),
  };
}

// Pinned to match the subproject defaults so bun resolves one TypeScript and
// one runtime-compatible set of Bun globals across the workspace.
const DEV_DEPS_ROOT: string[] = [
  "typescript@^5.9.3",
  `@types/bun@${BUN_VERSION}`,
  "@types/node@^24.6.0",
];
function validateReleaseOptions(options: DBXToolsJavaScriptProjectOptions): void {
  if (
    options.releaseMode === "disabled" &&
    (options.releaseDocs !== undefined || options.nodeRelease !== undefined)
  ) {
    throw new Error("releaseMode disabled cannot be combined with releaseDocs or nodeRelease");
  }
}

/** Options for {@link DBXToolsNodeProject} (the monorepo root). */
export type DBXToolsReleaseMode = "dbx-tools" | "disabled";

/** Native constructor fields resolved for one filesystem-discovered package. */
export interface DiscoveredTypeScriptPackageOptions {
  readonly name: string;
  readonly description?: string;
  readonly entrypoint?: string;
  readonly publishable?: boolean;
}

type SupportedWorkflowOptions = Pick<
  ReleaseProjectOptions,
  "postBuildSteps" | "workflowContainerImage" | "workflowRunsOn" | "workflowRunsOnGroup"
>;

/** Options shared by discovered package roots and standalone JavaScript projects. */
export type DBXToolsJavaScriptProjectOptions = CommonProjectOptions &
  Partial<
    Omit<javascript.NodeProjectOptions, keyof ReleaseProjectOptions | "release" | "releaseToNpm">
  > &
  Partial<SupportedWorkflowOptions> &
  DBXToolsConfigOptions &
  DBXToolsPNPMWorkspaceOptions & {
    /**
     * The npm scope for generated package names (`@<scope>/<seg-...>`). Defaults to
     * the (resolved) project name; a leading `@` is optional.
     */
    readonly scope?: string;
    /**
     * Roots scanned for packages (each `src`-bearing folder under a root is one).
     * Only a ROOT scans. Defaults to {@link DEFAULT_PACKAGE_ROOTS}.
     */
    readonly packageRoots?: readonly string[];
    /**
     * Leading path segment(s) dropped from a discovered package's relative path
     * before its npm name is derived, so a tier folder doesn't become a name
     * prefix. E.g. with the default `"node"`, `packages/node/path` names as
     * `@<scope>/path` instead of `@<scope>/node-path` (its `node` TAG still
     * derives from the path). One or many segment names; a segment is only
     * stripped when it is the FIRST segment of the relative path. Pass `[]` to
     * disable. Defaults to `"node"`.
     */
    readonly omitRelativePrefix?: OneOrMany<string>;
    /** Resolve native constructor fields before a discovered package is constructed. */
    readonly resolvePackageOptions?: (
      pkg: DiscoveredPackage,
      defaults: DiscoveredTypeScriptPackageOptions,
    ) => DiscoveredTypeScriptPackageOptions;
    /**
     * Maps a path token / relPath / glob to tag(s), unioned into a package's
     * path-derived tags. Defaults to an identity map over the known tag names; a
     * `""`/`"."` key tags the root.
     */
    readonly packageTagPaths?: Record<string, string[]>;
    /**
     * Which built-in {@link PACKAGE_TAG_MIXINS} to apply and seed
     * `packageTagPaths` identity entries for. Omitted = all; `false` = none;
     * a list = only those tags.
     */
    readonly defaultTagMixins?: false | PackageTag[];
    /**
     * Extra repo-root paths that trigger a full re-synth during `sync --watch`
     * (alongside `.projenrc.ts`). Repo-relative, e.g. `".example.projenrc.ts"`.
     */
    readonly syncResynthPaths?: readonly string[];
    /** GitHub Pages documentation included in the unified release workflow. */
    readonly releaseDocs?: ReleaseDocsOptions;
    /** Python package root passed to local release preparation when configured. */
    readonly releasePythonRoot?: string;
    /** Repository task names run during local release preparation before publication. */
    readonly releaseValidationTasks?: readonly string[];
    /** Release build prerequisites installed before repository validation tasks. */
    readonly releaseSetupSteps?: readonly JobStep[];
    /** Repository-specific synthesis commands run before release source verification. */
    readonly releaseSynthesisCommands?: readonly string[];
    /** Set to `false` to omit normal npm workspace publication. */
    readonly nodeRelease?: boolean;
    /** Unified dbx-tools release workflow, or no release surface. Defaults to `dbx-tools`. */
    readonly releaseMode?: DBXToolsReleaseMode;
    /** Prefix for generated release tags. Defaults to `v`. */
    readonly releaseTagPrefix?: string;
    /**
     * Extra workspace member paths (repo-relative, POSIX) to list in the workspace
     * config ALONGSIDE the discovered `packageRoots` members - for a package that
     * is synthesized by its OWN `.projenrc.ts` (so it isn't a root subproject) but
     * should still resolve as a workspace sibling. The `@dbx-tools/projen` engine in
     * `projen/` is the case: it synthesizes itself (avoiding a dogfooding cycle) yet
     * is a member of the single bun workspace, so the root links it from source.
     */
    readonly extraWorkspaceMembers?: readonly string[];
    /**
     * Install workspace dependencies once from the custom root instead of once
     * per child project during post-synthesis. Defaults to `true`; set `false` to
     * preserve projen's native per-project install tasks.
     */
    readonly rootInstallOnly?: boolean;
  };

/** Options for {@link DBXToolsTypeScriptProject} (a package, or a compiling root). */
export type DBXToolsTypeScriptProjectOptions = Partial<
  Omit<
    typescript.TypeScriptProjectOptions,
    keyof ReleaseProjectOptions | "release" | "releaseToNpm"
  >
> &
  DBXToolsJavaScriptProjectOptions;

/**
 * A monorepo root. Scans `packageRoots` and appends a
 * {@link DBXToolsTypeScriptProject} per `src`-bearing folder, then emits the
 * shared config, tasks, `pnpm-workspace.yaml`, and barrels-on-synth.
 */
export class DBXToolsNodeProject
  extends javascript.NodeProject
  implements DBXToolsJavaScriptProject
{
  readonly language = "javascript" as const;
  readonly scope: string;
  readonly dbxToolsConfig: DBXToolsConfig;
  pnpmWorkspace?: PnpmWorkspaceState;
  rootTsconfig?: DBXToolsRootTsconfig;
  readonly extraWorkspaceMembers: readonly string[];
  readonly releaseBranch: string;
  private readonly rootInstallOnly: boolean;

  constructor(options: DBXToolsJavaScriptProjectOptions = {}) {
    validateReleaseOptions(options);
    const { name, scope } = resolveIdentity(options);
    // Holds the workspace state (members/catalog/allowBuilds/overrides). Under
    // bun, projen's base constructor does NOT create the `PnpmWorkspaceYaml`
    // component (its `configurePnpm` call site is gated to pnpm), so this state's
    // options are wired into a directly-constructed component below - AND mirrored
    // into `package.json` (`workspaces`/`catalog`) for bun to read. The
    // `pnpm-workspace.yaml` is still emitted for the Databricks Apps pnpm install.
    const pnpmWorkspace = new PnpmWorkspaceState(options);
    super({
      ...defaultProjectOptions(options),
      pnpmOptions: {
        ...options.pnpmOptions,
        workspaceYamlOptions: pnpmWorkspace.options,
      },
      name,
    });

    this.pnpmWorkspace = pnpmWorkspace;
    // Emit `pnpm-workspace.yaml` ourselves: under bun projen skips the native
    // component, but the file is still required by the Databricks Apps platform
    // (its build phase installs with pnpm and reads catalog + `allowBuilds`).
    pnpmWorkspace.attachWorkspaceFile(this);
    this.package.addVersion(readWorkspaceVersion(this.outdir));
    this.scope = scope;
    this.extraWorkspaceMembers = options.extraWorkspaceMembers ?? [];
    this.releaseBranch = options.defaultReleaseBranch ?? "main";
    this.rootInstallOnly = options.rootInstallOnly !== false;
    this.dbxToolsConfig = new DBXToolsConfig(this, options);
    initProject(this, options);
  }

  public override preSynthesize(): void {
    prepareRootSynthesis(this, this.rootInstallOnly);
    super.preSynthesize();
    resolveRootWorkspace(this, this.extraWorkspaceMembers);
    preSynthesizeProject(this);
  }
}

/**
 * Root-owned workspace install policy.
 *
 * Every projen child has its own `NodePackage` post-synth hook, which otherwise
 * runs the install task against the same root workspace once per package. Clear
 * the public child install tasks while leaving dependency resolution and the
 * root's real install/install:ci tasks intact. Applied in root `preSynthesize`
 * so manually attached late children are included and repeated synths remain
 * idempotent.
 */
export const ROOT_INSTALL_ONLY_MIXIN = mixin.create(
  (construct: IConstruct): construct is DBXToolsNodeProject | DBXToolsTypeScriptProject =>
    (construct instanceof DBXToolsNodeProject || construct instanceof DBXToolsTypeScriptProject) &&
    construct.parent !== undefined,
  (child) => {
    child.package.installTask.reset();
    child.package.installCiTask.reset();
  },
);

/**
 * A single package (usually created by a root's scan), or a standalone
 * compiling root. The agnostic tsconfig floor is applied at construction; the
 * source-first package fields (`main`/`types`/`exports` -> `index.ts`) and optional
 * Bun app scaffolding are applied after. Per-tag deps/tsconfig arrive later
 * via the {@link PACKAGE_TAG_MIXINS} the root applies.
 */
export class DBXToolsTypeScriptProject
  extends typescript.TypeScriptProject
  implements DBXToolsJavaScriptProject
{
  readonly language = "javascript" as const;
  readonly scope: string;
  readonly dbxToolsConfig: DBXToolsConfig;
  pnpmWorkspace?: PnpmWorkspaceState;
  rootTsconfig?: DBXToolsRootTsconfig;
  readonly extraWorkspaceMembers: readonly string[];
  readonly releaseBranch: string;
  private readonly rootInstallOnly: boolean;

  constructor(options: DBXToolsTypeScriptProjectOptions) {
    validateReleaseOptions(options);
    const { name, scope } = resolveIdentity(options);
    const parent = options?.parent;
    const pnpmWorkspace = parent ? undefined : new PnpmWorkspaceState(options);
    const packageManager =
      options.packageManager ??
      inheritedPackageManager(parent instanceof javascript.NodeProject ? parent : undefined);

    super({
      ...defaultTypeScriptProjectOptions(options),
      name: options.name ?? name,
      packageManager,
      ...(pnpmWorkspace
        ? {
            pnpmOptions: {
              ...options.pnpmOptions,
              workspaceYamlOptions: pnpmWorkspace.options,
            },
          }
        : {}),
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
    this.pnpmWorkspace = pnpmWorkspace;
    pnpmWorkspace?.attachWorkspaceFile(this);
    this.scope = scope;
    this.extraWorkspaceMembers = options.extraWorkspaceMembers ?? [];
    this.releaseBranch = options.defaultReleaseBranch ?? "main";
    this.rootInstallOnly = options.rootInstallOnly !== false;
    // Pairs with `jsx` in SHARED_COMPILER_OPTIONS: projen's default `include` is
    // `src/**/*.ts` only, which silently omits a `.tsx` file from the program
    // instead of failing, so authoring a React component would otherwise need
    // per-package tsconfig config to be compiled at all.
    this.tsconfig?.addInclude("src/**/*.tsx");
    this.dbxToolsConfig = new DBXToolsConfig(this, options);
    // Source-first entry: point the package at its package-ROOT `index.ts` barrel
    // so packages resolve each other's `@scope/pkg` imports to source.
    this.package.addField("type", "module");
    this.package.addField("exports", {
      ".": "./index.ts",
      ...srcModuleExports(this),
      "./package.json": "./package.json",
    });
    this.package.addVersion(readWorkspaceVersion(this.root.outdir));
    addPackageFiles(this, "index.ts", "src");
    if (existsSync(join(this.outdir, "exports.ts"))) addPackageFiles(this, "exports.ts");
    // `bun test` intercepts `node:test` (the suites keep using node:test) and
    // runs it with bun's own fast runner. The native no-tests option is portable
    // across Windows and Unix and lets packages without tests remain a no-op.
    this.testTask.exec("bun test test --pass-with-no-tests");
    initProject(this, options);
  }

  public override preSynthesize(): void {
    prepareRootSynthesis(this, this.rootInstallOnly);
    super.preSynthesize();
    resolveRootWorkspace(this, this.extraWorkspaceMembers);
    preSynthesizeProject(this);
  }
}

function prepareRootSynthesis(
  project: DBXToolsNodeProject | DBXToolsTypeScriptProject,
  rootInstallOnly: boolean,
): void {
  if (!project.parent && rootInstallOnly) project.with(ROOT_INSTALL_ONLY_MIXIN);
}

function resolveRootWorkspace(
  project: DBXToolsNodeProject | DBXToolsTypeScriptProject,
  extraWorkspaceMembers: readonly string[],
): void {
  if (project.parent) return;
  const version = readWorkspaceVersion(project.outdir);
  for (const member of extraWorkspaceMembers) {
    syncWorkspaceManifestVersion(join(project.outdir, member, "package.json"), version);
  }
  project.pnpmWorkspace?.resolveMembers(project, extraWorkspaceMembers);
}

/**
 * Regenerates the repo's generated source after synth: codegen modules, Python
 * Node bindings, then package barrels. Python binding generation owns cleanup,
 * so removing a configured package or module cannot leave stale files behind.
 *
 * projen only runs `postSynthesize` when `PROJEN_DISABLE_POST` is unset, so this
 * is skipped during the watcher's fast `runSynth` (which sets it); there barrels
 * are rebuilt explicitly. It also runs after `NodeProject`'s own post-synth
 * install, so codegen's `node_modules/...` inputs resolve.
 */
class GeneratedSource extends Component {
  public override preSynthesize(): void {
    const root = resolve(this.project.outdir);
    for (const subproject of this.project.subprojects) {
      if (!(subproject instanceof DBXToolsTypeScriptProject)) continue;
      const packagePath = toPosix(relative(root, subproject.outdir));
      const modules = codegenModulePaths(subproject.dbxToolsConfig.codegenInputs);
      for (const module of modules) {
        this.project.annotateGenerated(`/${packagePath}/${module}`);
      }
      if (modules.length === 0) continue;
      const current = (subproject.package.manifest.exports ?? {}) as Record<string, unknown>;
      const sourceExports = Object.fromEntries(
        modules.map((module) => [`./${module.slice("src/".length, -".ts".length)}`, `./${module}`]),
      );
      subproject.package.addField("exports", {
        ...Object.fromEntries(
          Object.entries(current).filter(([subpath]) => subpath !== "./package.json"),
        ),
        ...sourceExports,
        ...(current["./package.json"] ? { "./package.json": current["./package.json"] } : {}),
      });
    }
  }

  public override postSynthesize(): void {
    const projectRoot = this.project.outdir;
    const includeRoot = this.project instanceof DBXToolsTypeScriptProject;
    generateCodegen(projectRoot, { includeRoot });
    generatePythonNodeBindings(projectRoot);
    generateBarrels({ projectRoot, includeRoot });
  }
}

/**
 * Make the ROOT `compile` / `test` tasks actually validate the workspace.
 *
 * projen gives a monorepo root empty `compile`/`test` tasks - a child's tasks
 * are the child's business - so `bun run build` at the root type-checked nothing
 * and ran no package tests. Compilation groups ordinary package tsconfigs into
 * a few TypeScript processes and runs custom package lifecycles alongside them.
 * Tests use a small number of root runner groups, skip packages without tests,
 * and expose focused, changed, unit, integration, and full tiers. The test task
 * reads the current workspace list from `package.json`, so a newly added member
 * needs no re-synth.
 */
class WorkspaceValidationTasks extends Component {
  private configured = false;

  public constructor(project: DBXToolsNodeProject | DBXToolsTypeScriptProject) {
    super(project);
    if (project.parent) return;
    project.addTask("workspace:graph", {
      description: "Write the workspace dependency and reverse-dependency graph",
      execArgs: taskCommand("test-workspace.ts", "graph"),
    });
    project.addTask("test:focused", {
      description: "Run tests for explicit workspace packages or paths",
      execArgs: taskCommand("test-workspace.ts", "focused"),
      receiveArgs: true,
    });
    project.addTask("test:changed", {
      description: "Run tests for changed packages and their dependents",
      execArgs: taskCommand("test-workspace.ts", "changed"),
      receiveArgs: true,
    });
    project.addTask("test:unit", {
      description: "Run unit tests in grouped root runners",
      execArgs: taskCommand("test-workspace.ts", "unit"),
    });
    project.addTask("test:integration", {
      description: "Run integration and packed-consumer tests",
      execArgs: taskCommand("test-workspace.ts", "integration"),
    });
    project.addTask("test:all", {
      description: "Run all JavaScript, TypeScript, and Python tests",
      execArgs: taskCommand("test-workspace.ts", "all"),
    });
  }

  public override preSynthesize(): void {
    if (this.configured) return;
    this.configured = true;
    const project = this.project as DBXToolsNodeProject | DBXToolsTypeScriptProject;
    if (project.subprojects.length === 0 && project.extraWorkspaceMembers.length === 0) {
      return;
    }
    project.compileTask.execArgs(taskCommand("compile-workspace.ts"));
    project.testTask.spawn(project.tasks.tryFind("test:all")!);
  }
}

/**
 * Ignore each codegen-declaring package's generated modules from root ESLint.
 * Those modules are read-only (ts-to-zod); lint `--fix` otherwise EACCES-crashes
 * on them. Runs in `preSynthesize` so mixin-added typed config is visible.
 */
class EslintIgnoreCodegen extends Component {
  public override preSynthesize(): void {
    const eslint = javascript.Eslint.of(this.project);
    if (!eslint) return;
    const rootAbs = resolve(this.project.outdir);
    for (const sub of this.project.subprojects) {
      if (!(sub instanceof DBXToolsTypeScriptProject)) continue;
      if (sub.dbxToolsConfig.codegenInputs.length === 0) continue;
      const rel = toPosix(relative(rootAbs, sub.outdir));
      // Ignore the generated MODULES, not the package's whole `src/`. A codegen
      // package may hold hand-written modules next to its generated ones
      // (shared-genie generates `dashboards.ts` beside a hand-written
      // `genie-model.ts`), and a blanket `src/**` would silently stop linting
      // them - the failure mode being invisible, since ESLint just reports less.
      for (const module of codegenModulePaths(sub.dbxToolsConfig.codegenInputs)) {
        eslint.addIgnorePattern(`${rel}/${module}`);
      }
    }
  }
}

/**
 * Keep generated package barrels and codegen modules out of root formatting.
 *
 * Their generators own the layout and may mark outputs read-only. Package paths
 * are derived from attached subprojects so custom `packageRoots` need no manual
 * Prettier patterns.
 */
class PrettierIgnoreGenerated extends Component {
  public override preSynthesize(): void {
    const prettier = javascript.Prettier.of(this.project);
    if (!prettier) return;
    prettier.addIgnorePattern("**/src/generated/**");
    const rootAbs = resolve(this.project.outdir);
    for (const sub of this.project.subprojects) {
      if (!(sub instanceof DBXToolsTypeScriptProject)) continue;
      const rel = toPosix(relative(rootAbs, sub.outdir));
      prettier.addIgnorePattern(`${rel}/index.ts`);
      for (const module of codegenModulePaths(sub.dbxToolsConfig.codegenInputs)) {
        prettier.addIgnorePattern(`${rel}/${module}`);
      }
    }
    const extraMembers = (this.project as DBXToolsNodeProject).extraWorkspaceMembers ?? [];
    for (const member of extraMembers) {
      prettier.addIgnorePattern(`${member}/index.ts`);
    }
  }
}

/** Default leading path segment stripped from a package's name (not its tag). */
const DEFAULT_OMIT_RELATIVE_PREFIX = ["node"];

/** Normalize the {@link DBXToolsJavaScriptProjectOptions.omitRelativePrefix} option to a slug list. */
function resolveOmitRelativePrefix(option: OneOrMany<string> | undefined): string[] {
  const raw = option === undefined ? DEFAULT_OMIT_RELATIVE_PREFIX : option;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((segment) => stringUtils.toSlug(segment)).filter(Boolean);
}

/**
 * Derive a package's npm name from its scope + relative path, dropping a leading
 * `omitPrefixes` segment first (so a tier folder like `node/` doesn't become a
 * name prefix). The full `relPath` is still used elsewhere for tags.
 */
function packageNameFor(scope: string, relPath: string, omitPrefixes: string[]): string {
  const segments = relPath.split("/").filter(Boolean);
  if (segments.length > 1 && omitPrefixes.includes(stringUtils.toSlug(segments[0]!))) {
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
function resolveIdentity(options: {
  name?: string;
  scope?: string;
  outdir?: string;
  parent?: Project;
}): {
  name: string;
  scope: string;
} {
  const projectRoot = options.parent
    ? resolve(options.parent.outdir, options.outdir ?? ".")
    : resolve(options.outdir ?? process.cwd());
  const name = options.name && options.name.length ? options.name : projectName(projectRoot);
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
  const engine = readPackageManifest(dirname(enginePkgJson));
  const name = stringUtils.trimToNull(engine?.name);
  if (!name) return undefined;
  const version = stringUtils.trimToNull(engine?.version);

  // No existing consumer manifest (or no entry) falls through to a computed pin.
  const consumer = readPackageManifest(resolve(project.outdir));
  const dependencyOf = (field: unknown): string | undefined =>
    object.isRecord(field) ? (stringUtils.trimToNull(field[name]) ?? undefined) : undefined;
  const existing = dependencyOf(consumer?.devDependencies) ?? dependencyOf(consumer?.dependencies);
  if (existing) return `${name}@${existing}`;
  return `${name}@^${version}`;
}

/** Resolve which {@link PACKAGE_TAG_MIXINS} keys to apply from `defaultTagMixins`. */
function resolveEnabledTagMixins(selection: false | PackageTag[] | undefined): PackageTag[] {
  if (selection === false) return [];
  if (selection === undefined) {
    return Object.keys(PACKAGE_TAG_MIXINS) as PackageTag[];
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
  project.addTask("barrels", { execArgs: taskCommand("barrels.ts") });
  project.addTask("clean", { execArgs: taskCommand("clean.ts"), receiveArgs: true });
  project.addTask("sync", {
    execArgs: taskCommand("sync.ts"),
    receiveArgs: true,
  });
}

/** Stable argv for a TypeScript task shipped by `@dbx-tools/projen`. */
export function taskCommand(script: string, ...args: string[]): string[] {
  const scriptPath = toPosix(join("node_modules", "@dbx-tools", "projen", "tasks", script));
  return ["bun", scriptPath, ...args];
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
  options: DBXToolsJavaScriptProjectOptions,
): void {
  // projen's GithubProject seeds a `# replace this` SampleReadme on every
  // project. READMEs are hand-written and owned outside projen, so drop the
  // generated one (and never mark it read-only) - both root and child.
  project.tryRemoveFile("README.md");

  if (project.parent) {
    project.package.file.readonly = true;
    // `build` already compiles before its `package` phase. Keep the package's
    // `prepack` for standalone `bun publish`, but suppress lifecycle scripts in
    // this generated pack step so a direct child build does not compile twice.
    const packageSteps = project.packageTask.steps;
    const packageStepIndex = packageSteps.findIndex(
      (step) => step.execArgs?.[0] === "npm" && step.execArgs[1] === "pack",
    );
    const packageStep = packageSteps[packageStepIndex];
    if (packageStep?.execArgs && !packageStep.execArgs.includes("--ignore-scripts")) {
      project.packageTask.updateStep(packageStepIndex, {
        ...packageStep,
        execArgs: [...packageStep.execArgs, "--ignore-scripts"],
      });
    }
    return;
  }

  if (project instanceof DBXToolsNodeProject) {
    project.rootTsconfig = new DBXToolsRootTsconfig(project);
  }
  const projenrc = new typescript.ProjenrcTs(project, {
    runner: typescript.TypeScriptRunner.nodejs(),
  });
  const projenrcBase =
    project instanceof DBXToolsTypeScriptProject ? project.tsconfig : project.rootTsconfig?.config;
  if (projenrcBase) projenrc.tsconfig.addExtends(projenrcBase);
  projenrc.tsconfig.removeInclude("**/*.ts");
  // bun runs `.projenrc.ts` directly (native TS, no loader to register). Reset to
  // a plain `bun` exec rather than any wrapper: the default task is spawned by
  // nested installs/synths, and a wrapper that exported `npm_config_*` broke them.
  project.defaultTask?.reset("bun .projenrc.ts");

  // Pin bun's hoisted linker workspace-wide (see RootBunfigFile) so a peer dep
  // resolves to one copy and singletons/types stay coherent.
  new RootBunfigFile(project);

  // Only reached on a ROOT (early-returned above otherwise), so the root devDeps
  // always apply; the self-dep is added only when the engine is an installed pkg.
  const selfDep = engineSelfDependency(project);
  if (selfDep) project.addDevDeps(selfDep);
  project.addDevDeps(...DEV_DEPS_ROOT);
  configureRootPackage(project);
  // Workspaces generated by this engine intentionally do not track local-registry
  // lockfiles, so the CI-named install task must resolve from manifests as well.
  project.package.installCiTask.reset("bun install");
  const roots = options.packageRoots ?? DEFAULT_PACKAGE_ROOTS;
  project.dbxToolsConfig.packageRoots = [...roots];
  if (options.syncResynthPaths?.length) {
    project.dbxToolsConfig.syncResynthPaths = [...options.syncResynthPaths];
  }

  configureVsCode(project);

  registerRootTasks(project);
  if (options.prettier || project.prettier) {
    const formatTask = project.tasks.tryFind("format") ?? project.addTask("format");
    formatTask.prependExec("prettier . --write", { receiveArgs: true });
  }

  // `dot: false` for the same reason as `test: false`: the dot group is a
  // SCANNING concern (skip `.git` and caches when walking the tree), and a
  // blanket `**/.*` in a `.gitignore` is both wrong and actively harmful. A repo
  // legitimately commits `.github/`, `.projen/tasks.json`, `.vscode/settings.json`,
  // `.editorconfig`. Worse, `**/.*` excludes those DIRECTORIES, and git refuses
  // to re-include a file whose parent directory is excluded - so every per-file
  // `!/.github/...` negation projen emits for its own generated files silently
  // does nothing, and the file cannot be added at all.
  project.gitignore.addPatterns(
    ...[...ignore.ignorePatterns({ test: false, dot: false, lock: true })],
  );
  // What the dot group was actually earning here, named explicitly: secrets and
  // local editor state. Both ignore CONTENTS (`.idea/*`) rather than the
  // directory, so a later `!` negation can still reach a file inside.
  project.gitignore.addPatterns(".env", ".env.*", "!.env.example", "!.env.sample", ".idea/*");
  for (const root of roots) {
    project.annotateGenerated(`/${root}/**/index.ts`);
    project.annotateGenerated(`/${root}/**/src/generated/**`);
  }
  for (const member of project.extraWorkspaceMembers) {
    project.annotateGenerated(`/${member}/index.ts`);
  }

  // ESLint lives ONLY on the root and lints every package. `projectService` resolves
  // each file to its own package tsconfig (so type-aware rules work tree-wide), and
  // `import/no-extraneous-dependencies` still checks each file against its nearest
  // package.json. Formatting defers to the root Prettier to avoid rule/formatter
  // conflicts (e.g. quote style). The normal task is check-only so CI never
  // repairs the worktree it is meant to validate; `eslint:fix` is the explicit
  // local mutation path.
  const eslint = new javascript.Eslint(project, {
    dirs: [...roots, ...project.extraWorkspaceMembers],
    fileExtensions: [".ts", ".tsx"],
    projectService: true,
    prettier: Boolean(project.prettier),
    tsconfigPath:
      project instanceof typescript.TypeScriptProject
        ? (project.tsconfig?.fileName ?? "./tsconfig.json")
        : "./tsconfig.json",
    commandOptions: { fix: false },
  });
  eslint.allowDefaultProjectFiles(".projenrc.ts");
  project.addTask("eslint:fix", {
    description: "Fix ESLint issues across the codebase",
    exec: "bun run eslint -- --fix",
  });
  // Generated read-only outputs (barrels, app scripts, and codegen). ESLint
  // --fix cannot rewrite files owned by the barrel generator, codegen, or projen.
  for (const root of roots) {
    eslint.addIgnorePattern(`${root}/**/index.ts`);
  }
  eslint.addIgnorePattern("**/src/generated/**");
  for (const member of project.extraWorkspaceMembers) {
    eslint.addIgnorePattern(`${member}/index.ts`);
  }
  // The generated bun app scripts + unmanaged overrides live at the package root,
  // outside any `src/**` tsconfig include, so the type-aware parser cannot resolve
  // them to a project. ESLint still cannot parse them.
  eslint.addIgnorePattern("**/dev.ts");
  eslint.addIgnorePattern("**/build.ts");
  for (const override of BUN_APP_OVERRIDES) {
    eslint.addIgnorePattern(`**/${override}`);
  }
  // Codegen inputs may be added by mixins after construction; ignore their
  // generated modules once typed package configuration is final.
  new EslintIgnoreCodegen(project);
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
  if (eslint.config?.settings) {
    // eslint-plugin-import knows Node built-ins but not Bun's test module.
    eslint.config.settings["import/core-modules"] = ["bun:test"];
  }
  // Point the TS import resolver at every package tsconfig, not just the root's
  // (which only includes `.projenrc.ts`), so `import/no-unresolved` resolves
  // cross-package imports.
  const tsResolver = eslint.config?.settings?.["import/resolver"]?.typescript;
  if (tsResolver) {
    tsResolver.project = [
      "tsconfig.json",
      ...roots.map((r) => `${r}/**/tsconfig.json`),
      ...project.extraWorkspaceMembers.map((member) => `${member}/tsconfig.json`),
    ];
  }

  const enabledTagMixins = resolveEnabledTagMixins(options.defaultTagMixins);
  const omitPrefixes = resolveOmitRelativePrefix(options.omitRelativePrefix);

  // path token/relPath/glob -> tag(s). Default: identity over the enabled tag names;
  // any packageTagPaths entries AUGMENT that. A `""`/`"."` key tags the root.
  const tagPaths: Record<string, string[]> = {
    ...Object.fromEntries(enabledTagMixins.map((k) => [k, [k]])),
    ...(options.packageTagPaths ?? {}),
  };

  // Already-attached subprojects, keyed by repo-relative member path.
  const rootAbs = resolve(project.outdir);
  const existing = new Map<string, DBXToolsJavaScriptProject>();
  for (const sub of project.subprojects) {
    if (sub instanceof DBXToolsNodeProject || sub instanceof DBXToolsTypeScriptProject) {
      existing.set(toPosix(relative(rootAbs, sub.outdir)), sub);
    }
  }

  // Discover + append a child per src-bearing folder. A root encapsulating an
  // already-attached project doesn't re-create it, it just unions the tags in. The
  // agnostic floor is set in the child's constructor; per-tag deps/tsconfig come from
  // the PACKAGE_TAG_MIXINS applied across the subtree below.
  for (const p of scanPackages(rootAbs, roots)) {
    const tags = [...object.sequence(p.tagCandidates, resolveTags(p, tagPaths)).distinct()];
    const found = existing.get(p.memberPath);
    if (found) {
      found.dbxToolsConfig.tags.push(...tags);
      continue;
    }
    const defaultPackageName = packageNameFor(project.scope, p.relPath, omitPrefixes);
    const packageOptions =
      options.resolvePackageOptions?.(p, { name: defaultPackageName }) ??
      ({ name: defaultPackageName } satisfies DiscoveredTypeScriptPackageOptions);
    new DBXToolsTypeScriptProject({
      parent: project,
      outdir: p.memberPath,
      ...packageOptions,
      tags,
    });
  }

  // The root project may itself carry tags (via a `""`/`"."` tag-path key).
  const rootTags = [...object.sequence(tagPaths[""], tagPaths["."]).distinct()];
  if (rootTags.length) project.dbxToolsConfig.tags.push(...rootTags);

  // Apply per-tag mixins across the whole subtree now that every child exists
  // (`construct.with` captures the tree at call time). User mixins run afterward
  // via the caller's own `project.with(...)`.
  if (enabledTagMixins.length) {
    project.with(...enabledTagMixins.map((t) => PACKAGE_TAG_MIXINS[t]));
  }

  new WorkspaceValidationTasks(project);
  new PrettierIgnoreGenerated(project);
  new GeneratedSource(project);

  // Version mutation, reviewed release preparation, and public publication are
  // separate surfaces owned by one release component.
  if (options.releaseMode !== "disabled") {
    new DBXToolsRelease(project, {
      tagPrefix: options.releaseTagPrefix,
      nodeRelease: options.nodeRelease,
      docs: options.releaseDocs,
      pythonRoot: options.releasePythonRoot,
      validationTasks: options.releaseValidationTasks,
      setupSteps: options.releaseSetupSteps,
      synthesisCommands: options.releaseSynthesisCommands,
    });
  }
}

function preSynthesizeProject(project: javascript.NodeProject): void {
  // `Project.files` is OWN-project only (its `components` getter filters on the
  // project's own node path), so reaching a child's files means walking the tree.
  // `node.findAll()` is projen/constructs' native preorder walk - self first, then
  // descendants - which is the order the subproject recursion produced.
  const subtree = project.node.findAll().filter(Project.isProject);
  if (project.prettier) {
    const ignorePatterns = new Set<string>();
    for (const p of subtree) {
      p.files.forEach((file) => {
        if (file.readonly) ignorePatterns.add(file.path);
      });
    }
    ignorePatterns.forEach((pattern) => project.prettier!.addIgnorePattern(pattern));
  }
  for (const p of subtree) {
    if (!p.parent) continue;
    // Swap the source entry points for compiled ones in the PUBLISHED manifest
    // only. Runs here rather than in the constructor so the tags have already
    // installed their `exports` layouts for it to mirror.
    if (p instanceof javascript.NodeProject) applyCompiledPublish(p);
  }
}
