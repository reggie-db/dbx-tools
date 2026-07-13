/**
 * `configureProject(project?, options?)` - configure a projen `NodeProject` into a
 * tag-enforcing pnpm monorepo. If `project` is omitted, one is constructed from
 * {@link ENGINE_DEFAULTS} merged with `options.extends`; the passed-or-created
 * project is returned, and (unless `options.synth === false`) synthesized.
 *
 * Tags drive everything. A workspace package gets tags from three sources, unioned:
 *   1. tags it already carries (a pre-attached/preconfigured subproject);
 *   2. `workspacePackageTagPaths` (a path/pattern -> tag(s) map);
 *   3. its path segments under a `workspacePackageRoots` root (cumulative dash-join
 *      candidates: `dir/another/path` -> `[dir, dir-another, dir-another-path]`).
 * A tag with a known config applies it (deps + tsconfig overlay); the agnostic
 * default is the baseline floor. AFTER every package is
 * configured, a deferred pass runs the enabled default tag modifiers (see
 * `workspacePackageDefaults`) then the caller's `workspacePackage` hook, both
 * acting on the resolved tags. `pnpm-workspace.yaml` (source of truth) sources its
 * members from `project.subprojects`. A root that ENCAPSULATES an already-attached
 * project doesn't re-create it - it just adds the path-derived tags. The root
 * project may itself carry tags (via a `""`/`"."` tag-path key).
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Component, type FileBase, type Project, javascript, typescript } from "projen";
import { generateBarrels } from "./barrels";
import {
  DEFAULT_WORKSPACE_TAG,
  WORKSPACE_TAGS,
  type WorkspaceTag,
  type WorkspaceTagDef,
} from "./tags";
import * as files from "./files";
import {
  DEFAULT_WORKSPACE_PACKAGE_MODIFIERS,
  type DefaultWorkspacePackageTag,
  type WorkspacePackageModifier,
  type WorkspacePackageSpec,
  addWorkspacePackageTags,
  applyTags,
  lockPackageJson,
  npmNameOf,
} from "./packages";
import {
  DEFAULT_WORKSPACE_PACKAGE_ROOTS,
  type DiscoveredPackage,
  type OneOrMany,
  discoverPackages,
  escapeRegExp,
  projectName,
  toArray,
  toPosix,
} from "./workspace";

export type { ModifyPnpmWorkspace, PnpmWorkspaceConfig } from "./files";

/**
 * The pnpm `catalog:` version registry: dependency name -> version range. This is
 * a pnpm-workspace feature (packages reference it via a `catalog:` specifier), so
 * there is no projen type for it - it's just a string map.
 */
export type Catalog = Record<string, string>;

/** Default pnpm `catalog:` versions, pinned to match `databricks apps init` (AppKit). */
export const DEFAULT_CATALOG: Catalog = {
  react: "^19.2.4",
  "react-dom": "^19.2.4",
  "@types/react": "^19.2.2",
  "@types/react-dom": "^19.2.2",
  vite: "^7.1.14",
  "@vitejs/plugin-react": "^5.0.4",
  "@types/node": "^24.6.0",
  "@types/express": "^5.0.5",
  express: "^5.1.0",
  zod: "^4.3.6",
  typescript: "^5.9.3",
  commander: "^15.0.0",
  "@clack/prompts": "^1.7.0",
  "openapi-fetch": "^0.17.0",
  tsoa: "^6.6.0",
  pnpm: "^11.0.6",
};

/**
 * The engine's opinionated `NodeProject` defaults, used only when `configureProject`
 * has to CONSTRUCT the project (no project passed). `options.extends` overrides any
 * of these; `name` is resolved and applied separately.
 */
const ENGINE_DEFAULTS: Partial<javascript.NodeProjectOptions> = {
  defaultReleaseBranch: "main",
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

export interface ConfigureProjectOptions {
  /**
   * Root project name; also the npm scope for generated package names
   * (`@<name>/<seg-...>`). Auto-detected (git remote -> folder name) if omitted and
   * not derivable from a passed project.
   */
  readonly name?: string;
  /** Overrides merged over {@link ENGINE_DEFAULTS} when constructing the project. */
  readonly extends?: Partial<javascript.NodeProjectOptions>;
  /** Run `project.synth()` before returning. Default `true`. */
  readonly synth?: boolean;
  /**
   * Roots scanned for packages (each `src`-bearing folder under a root is one).
   * Defaults to {@link DEFAULT_WORKSPACE_PACKAGE_ROOTS} (`["workspaces"]`).
   */
  readonly workspacePackageRoots?: readonly string[];
  /**
   * Maps a path token / relPath / glob pattern to tag(s). A package's candidates,
   * relPath and memberPath are matched against the keys and the union of matches is
   * added to its tags. Defaults to an identity map over the (effective) tag names
   * (so `workspaces/ui/app` -> tag `ui`); explicit entries AUGMENT that identity.
   * A `""`/`"."` key tags the root project.
   */
  readonly workspacePackageTagPaths?: Record<string, OneOrMany<string>>;
  /**
   * Which built-in default tag modifiers may run (keys of
   * {@link DEFAULT_WORKSPACE_PACKAGE_MODIFIERS}), or `"all"`. Default `"all"`.
   */
  readonly workspacePackageDefaults?: DefaultWorkspacePackageTag[] | "all";
  /** Tag name -> config map. Defaults to the built-in {@link WORKSPACE_TAGS}. */
  readonly workspaceTags?: Record<string, WorkspaceTagDef>;
  /** Tags to turn off (removed from the tag map and the default tag-path identity). */
  readonly disableWorkspaceTags?: WorkspaceTag[];
  /** pnpm `catalog:` versions. Defaults to {@link DEFAULT_CATALOG}. */
  readonly catalog?: Catalog;
  /**
   * Per-workspace-package hook, run LAST (after the default tag modifiers) in a
   * deferred pass once every package is configured. Dispatch on `spec.tags`/`spec.name`.
   */
  readonly workspacePackage?: WorkspacePackageModifier;
  /** Hook to tweak the assembled `pnpm-workspace.yaml` object (members, catalog, ...). */
  readonly pnpmWorkspace?: files.ModifyPnpmWorkspace;
  /**
   * Callback invoked for every generated projen file (`package.json`, `tsconfig.json`,
   * `vite.config.ts`, `pnpm-workspace.yaml`, `.vscode/*`, ...) across the root and
   * every workspace package, in the deferred pass. Receives the file and its owning
   * project - use `file.path` to target one, and for JSON/YAML files
   * `(file as ObjectFile).addOverride(...)` to tweak it. (Barrels are written by
   * barrelsby, not projen, so they are not included here.)
   */
  readonly onGeneratedFile?: (file: FileBase, project: Project) => void;
}

/**
 * Regenerates every package's root `index.ts` barrel after synth - "barrels on
 * resynth" for the plain `projen` path. projen only runs `postSynthesize` when
 * `PROJEN_DISABLE_POST` is unset, so this is skipped during the watch loop's
 * `runSynth` (which sets it); there `dbxtools` calls `generateBarrels()` directly.
 */
class GeneratedBarrels extends Component {
  public override postSynthesize(): void {
    generateBarrels();
  }
}

/**
 * A devDep entry that keeps the engine itself resolvable for the *next* synth (a
 * consumer's `.projenrc.ts` imports `configureProject` from it). Resolved from the
 * engine's OWN nearby `package.json` for its name; `undefined` when running as
 * plain in-repo SOURCE (detected by whether the resolved path passes through a
 * `node_modules` segment). Reuses whatever specifier the consumer's `package.json`
 * already has for it rather than computing one (avoids repointing a `file:`/`link:`
 * install at the registry).
 */
function engineSelfDependency(project: javascript.NodeProject): string | undefined {
  const enginePkgJson = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  if (!toPosix(enginePkgJson).includes("/node_modules/")) return undefined;
  let name: string, version: string;
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
    // No existing package.json (or no entry for it) - fall through to a computed pin.
  }
  return `${name}@^${version}`;
}

/** Configure the monorepo project. Returns it (synthed unless `options.synth === false`). */
export function configureProject(
  project?: javascript.NodeProject,
  options: ConfigureProjectOptions = {},
): javascript.NodeProject {
  const {
    name: explicitName,
    extends: extendsOptions,
    synth = true,
    workspacePackageRoots = DEFAULT_WORKSPACE_PACKAGE_ROOTS,
    workspacePackageTagPaths,
    workspacePackageDefaults = "all",
    workspaceTags = WORKSPACE_TAGS,
    disableWorkspaceTags = [],
    catalog = DEFAULT_CATALOG,
    workspacePackage,
    pnpmWorkspace,
    onGeneratedFile,
  } = options;

  // Resolve name (options.name -> passed project's name -> auto git/folder), then
  // construct a default NodeProject when none was passed.
  const resolvedName = explicitName ?? npmNameOf(projectName());
  const proj =
    project ??
    new javascript.NodeProject({ ...ENGINE_DEFAULTS, ...extendsOptions, name: resolvedName });
  const name = proj.name && proj.name.length ? proj.name : resolvedName;

  const effectiveTags: Record<string, WorkspaceTagDef> = { ...workspaceTags };
  for (const e of disableWorkspaceTags) delete effectiveTags[e];

  // path token/relPath/glob -> tag(s). Default: identity over the effective tag
  // names; any workspacePackageTagPaths entries AUGMENT that.
  const tagPaths: Record<string, OneOrMany<string>> = {
    ...Object.fromEntries(Object.keys(effectiveTags).map((k) => [k, k])),
    ...(workspacePackageTagPaths ?? {}),
  };
  const enabledDefaults = new Set<string>(
    workspacePackageDefaults === "all"
      ? Object.keys(DEFAULT_WORKSPACE_PACKAGE_MODIFIERS)
      : workspacePackageDefaults,
  );

  // --- Root-level config -----------------------------------------------------
  if (!project) {
    // Only when we own construction (a passed project manages its own projenrc).
    new typescript.ProjenrcTs(proj, { runner: typescript.TypeScriptRunner.tsx() });
  }
  const selfDep = engineSelfDependency(proj);
  proj.addDevDeps(...(selfDep ? [selfDep] : []), "tsx@^4.23.0", "typescript@^5.9.3", "@types/node@^24.6.0");
  proj.package.addField("type", "module");
  proj.package.addField("private", true);
  lockPackageJson(proj);
  const watch = proj.tasks.tryFind("watch") ?? proj.addTask("watch");
  watch.reset("pnpm dbxtools sync --watch");
  files.pnpmWorkspace(proj, { catalog, modify: pnpmWorkspace });
  files.tsconfigBase(proj);
  files.tsconfigRoot(proj);
  files.prettierConfig(proj);
  files.prettierIgnore(proj);
  files.vscodeTasks(proj);
  files.vscodeSettings(proj);
  files.vscodeExtensions(proj);

  // --- Tag resolution --------------------------------------------------------
  const tagPathMatches = (key: string, p: DiscoveredPackage): boolean => {
    if (p.tagCandidates.includes(key)) return true;
    if (key === p.relPath || key === p.memberPath) return true;
    if (key.includes("*")) {
      const re = new RegExp(`^${key.split("*").map(escapeRegExp).join(".*")}$`);
      return re.test(p.relPath) || re.test(p.memberPath) || p.tagCandidates.some((c) => re.test(c));
    }
    return false;
  };
  const resolveTags = (p: DiscoveredPackage): string[] => {
    const tags: string[] = [];
    for (const [key, value] of Object.entries(tagPaths)) {
      if (tagPathMatches(key, p)) {
        for (const tag of toArray(value)) if (!tags.includes(tag)) tags.push(tag);
      }
    }
    return tags;
  };

  // Already-attached subprojects, keyed by repo-relative member path.
  const rootAbs = resolve(proj.outdir);
  const existing = new Map<string, javascript.NodeProject>();
  for (const sub of proj.subprojects) {
    if (sub instanceof javascript.NodeProject) {
      existing.set(toPosix(relative(rootAbs, sub.outdir)), sub);
    }
  }

  // --- Discover + configure packages (NO modifiers yet - see the deferred pass) ---
  const configured: { project: typescript.TypeScriptProject; spec: WorkspacePackageSpec }[] = [];
  for (const p of discoverPackages(rootAbs, workspacePackageRoots)) {
    const tags = resolveTags(p);
    const found = existing.get(p.memberPath);
    if (found) {
      // A root encapsulates an already-attached project: don't re-create it, just
      // union the path-derived tags into it.
      addWorkspacePackageTags(found, tags);
      continue;
    }
    const packageName = npmNameOf(name, p.relPath);
    // DEFAULT_WORKSPACE_TAG is the baseline floor; each known tag's config merges on top.
    const config = [
      DEFAULT_WORKSPACE_TAG,
      ...tags.map((t) => effectiveTags[t]).filter((d): d is WorkspaceTagDef => !!d),
    ];
    const spec: WorkspacePackageSpec = { tags, name: p.name, packageName };
    const sub = applyTags(proj, { outdir: p.memberPath, name: packageName, config, tags, spec });
    configured.push({ project: sub, spec });
  }

  // The root project may itself carry tags (via a `""`/`"."` tag-path key).
  const rootTags = [...new Set([...toArray(tagPaths[""]), ...toArray(tagPaths["."])])];
  if (rootTags.length) addWorkspacePackageTags(proj, rootTags);

  // Barrels regenerate on every (plain) synth.
  new GeneratedBarrels(proj);

  proj.gitignore.addPatterns(
    ".DS_Store",
    "dist",
    "**/dist",
    "*.tsbuildinfo",
    "node_modules/.cache",
    ".env",
    "tmp",
  );
  for (const root of workspacePackageRoots) {
    proj.annotateGenerated(`/${root}/**/index.ts`);
    proj.annotateGenerated(`/${root}/openapi/**`);
  }

  // --- Deferred modifier pass: AFTER every package is configured, run the enabled
  // default tag modifiers, then the caller's workspacePackage hook (LAST), each
  // acting on the resolved tags.
  for (const { project: sub, spec } of configured) {
    for (const tag of spec.tags) {
      if (enabledDefaults.has(tag) && tag in DEFAULT_WORKSPACE_PACKAGE_MODIFIERS) {
        DEFAULT_WORKSPACE_PACKAGE_MODIFIERS[tag as DefaultWorkspacePackageTag](sub, spec);
      }
    }
    workspacePackage?.(sub, spec);
  }

  // Generated-file callback: every projen file across the root + all packages.
  if (onGeneratedFile) {
    const visitFiles = (pj: Project): void => {
      for (const file of pj.files) onGeneratedFile(file, pj);
    };
    visitFiles(proj);
    for (const sub of proj.subprojects) visitFiles(sub);
  }

  if (synth) proj.synth();
  return proj;
}
