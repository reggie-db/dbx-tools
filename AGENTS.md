# AGENTS.md

Orientation for AI agents / new contributors. Read this first.

## What this repo is

A **projen-driven pnpm monorepo generator**. The reusable engine lives in
**`@dbx-tools/shared-projen`** (`workspaces/shared/projen`); **`@dbx-tools/cli`**
(`workspaces/cli/dbx-tools`) is the published CLI package that re-exports the
engine and ships **`dbxtools`**. Both are dogfooded as normal auto-discovered
packages (not special cases). The engine exports two projen project subclasses —
**`DBXToolsNodeProject`** (the monorepo root) and **`DBXToolsTypeScriptProject`**
(a package) — plus **mixin** helpers (the `predicate.hasName`/`predicate.hasTag`/`predicate.inRelPath`
predicate namespace and the `mixin(predicate, consumer)` factory) for per-package tweaks.

- **`workspaces/`** — real content goes here.
- **`example-workspaces/`** — the seed example packages this repo ships
  (`cli/main`, `server/api`, `shared/core`, `shared/fun`, `shared/neat`, `ui/app`),
  kept in a separate root so they stay visually distinct from anything you build.

> Local dir is `dbx-tools/`; the GitHub repo is `reggie-db/dbx-tools`
> (default branch **`main`**).

## Vocabulary (important)

- **tag** — a label a workspace package carries (Bit-style; it names the target
  _environment_ — React/Vite, Node, agnostic, …). A package can carry MANY tags,
  or none. Tags are NOT npm scopes. They come from three sources, unioned and
  deduped: (1) tags already on a project you attached yourself, (2) matches in
  `workspacePackageTagPaths`, (3) the cumulative dash-join of the folder's path
  segments relative to its root (`ui/app` → `[ui, ui-app]`).
- **scope** — reserved for the npm `@scope/` in package identifiers (e.g. the
  `@dbx-tools` in `@dbx-tools/ui-app`). Don't call tags "scopes".
- **workspace package** — a `src`-bearing folder under a `workspacePackageRoots`
  root (e.g. `workspaces/ui/app`), named `@<scope>/<path-dash-joined>`.

## Mental model

- **`new DBXToolsNodeProject(options?)` gives you a configured monorepo root**
  (`project.ts`). It extends projen's `NodeProject`, merging its opinionated
  defaults (`defaultNodeProjectOptions`/`defaultTypeScriptProjectOptions`, root-aware
  functions keyed off `options.parent`: pnpm, no jest/eslint/github/release/depsUpgrade,
  no `devEngines.packageManager`, since pnpm 11 errors if that and
  `packageManager` are both set; projen's built-in prettier runs on the ROOT only)
  under anything you pass. You then call
  `project.synth()` yourself. A normal consuming `.projenrc.ts` is two lines:
  `const project = new DBXToolsNodeProject(); project.synth();`. Both classes
  share `DBXToolsCommonOptions` (`scope`, `workspacePackageRoots`,
  `workspacePackageTagPaths`, `defaultTagMixins`), which
  `extends` the component option bags directly — `DBXToolsConfigOptions` (`tags`)
  and `DBXToolsPNPMWorkspaceOptions` (`packages`/`catalog`/`allowBuilds`) — so those
  are top-level options, not nested fields. Both implement the single
  `DBXToolsProject` interface (`project.ts`; extends projen's `NodeProject`):
  `scope`/`packageIdentifier`/`packageNameFor` plus the config
  COMPONENTS as fields (projen-style, like `project.eslint?.addRules(...)`) —
  `project.dbxToolsConfig` (implements
  `ITagging`: `tags` + `addTags`, distinct/order-preserving, read/written directly on
  `package.json` `dbxToolsConfig.tags` — never cached on a field) and
  `project.pnpmWorkspace` (implements `IPnpmWorkspace`:
  `addPackages`/`addCatalog`/`allowBuild`; ROOT-only, so `undefined` on a child).
  Call methods on those fields directly (`project.dbxToolsConfig.addTags(...)`), not
  via delegator methods on the project.
- **`pnpm-workspace.yaml` is the source of truth**, emitted by the
  `DBXToolsPNPMWorkspace` component (`pnpm-workspace.ts`) exposed as the root's
  `project.pnpmWorkspace` field. The root scans the filesystem ONCE at synth
  (under each `workspacePackageRoots` root, default `["workspaces"]`) and the
  file's `packages:` list is sourced from `project.subprojects` at synth via a
  thunk (so member order/timing never matters) — every discovered package becomes
  a real subproject, no manual member list. Mutate it through the typed methods
  `project.pnpmWorkspace?.addCatalog(name, version)` / `.allowBuild(name)` /
  `.addPackages(glob)` (or `file.addOverride(...)` for any other pnpm setting), not
  by editing the YAML. Discovery is TWO functions in `workspace.ts`:
  `scanPackages(root, roots)` walks the filesystem (synth time; returns each
  package's path + the tags implied by its path, reading no manifest), while
  `workspacePackages()` reads the recorded members back from `pnpm-workspace.yaml`
  and augments each with the `name` + `tags` from its own `package.json` — what
  every post-synth command (`barrels`, the watcher, `openapi`) uses.
- **Discovery + tag resolution.** Under each `workspacePackageRoots` root (this
  repo passes `["workspaces", "example-workspaces"]`), ANY `src`-bearing folder at
  ANY depth is a package. Its path relative to the root is decomposed into
  cumulative dash-join **tag candidates**: `ui/app` → `[ui, ui-app]`;
  `dir/another/path` → `[dir, dir-another, dir-another-path]`. Each candidate is
  looked up in **`workspacePackageTagPaths`** (`Record<token, string[]>`,
  default: identity over the tag names) and the union of matches — together with
  any tags already on a pre-attached project — is the package's applied tags,
  possibly NONE (then only the agnostic default applies). The deduped tag list is
  written to each package's `package.json` under **`dbxToolsConfig.tags`** (the
  per-package source of truth, surfaced post-synth as `workspacePackages()[].tags`)
  and read back via the `DBXToolsConfig` component (`pkg.dbxToolsConfig.tags`, the
  basis a `project.mixin(...)` dispatches on). No declaration needed — drop a `src/`
  folder, re-synth.
- **A root may already hold in-tree subprojects.** If a discovered folder matches
  a subproject already attached to the root, it is NOT re-created — the resolved
  tags are unioned onto it (`dbxToolsConfig.addTags` for a DBXTools project, else
  `addWorkspacePackageTags`). The root itself can also carry tags (a `""`/`"."`
  key in `workspacePackageTagPaths`, or the `tags` option).
- **Every package is a `DBXToolsTypeScriptProject`** (extends
  `typescript.TypeScriptProject`). The root's scan constructs one per discovered
  folder with `parent: root`; you can also `new DBXToolsTypeScriptProject({parent,
...})` directly to attach a package WITHOUT auto-discovery. Every package gets
  the agnostic tsconfig floor (`AGNOSTIC_COMPILER_OPTIONS`: ES2022, no DOM/node) at
  construction; the class then points `main`/`types`/`exports` at the package-root
  `index.ts` barrel, applies any explicit `tasks`, optionally emits
  `vite.config.ts`, and locks `package.json`. Per-tag deps/tsconfig/tasks are
  layered afterward by the tag MIXINS the root applies (see below).
  projen OWNS that package's `package.json`/`tsconfig.json`/tasks/`README.md`/
  `.projen/`; baseline projen features are off to match the root (`SUBPROJECT_
DEFAULTS`; `sampleCode: false` stops projen dropping template `src/` files).
- **Tags are ONE map of mixins.** `tags.ts` — `WORKSPACE_TAG_MIXINS`
  (`Record<WorkspaceTag, IMixin>`, keyed by tag name). Each entry is a
  `tagMixin(name, fn)` that, for every package carrying the tag, adds the tag's
  projen-native `deps`/`devDeps` (`@catalog:` specifiers) and OVERRIDES the
  generated tsconfig via `applyCompilerOptions` (projen enums, e.g.
  `TypeScriptJsxMode.REACT_JSX`) — layered over the `AGNOSTIC_COMPILER_OPTIONS`
  floor so tag `lib`/`jsx`/`types`/`target` win. Some also `applyTasks` / emit
  `vite.config.ts`:
  - `ui` → Vite/React (DOM + `vite/client` types, jsx, `vite.config.ts`)
  - `server` → Node (`@types/node`, `tsoa` + `experimentalDecorators`, no DOM)
  - `node` → Node (`@types/node`, no DOM)
  - `cli` → Node + `commander` + `@clack/prompts`
  - `shared` → agnostic (the `AGNOSTIC_COMPILER_OPTIONS` floor: no DOM, no Node)
  - `openapi` → generated, read-only clients (`openapi-fetch`, DOM libs)
    Enforcement is real via each package's generated `tsconfig` `lib`/`types`:
    `document` in `shared`/`server` fails `tsc`; `process`/`node:*` in `ui` fails.
- **Per-package behavior is MIXINS** (`mixin.ts`; `constructs` `IMixin`). A mixin
  is `{ supports(c), applyTo(c) }`, applied with the constructs-native
  `construct.with(...mixins)` — it runs each across the construct's whole subtree
  (tree captured at call time), so a root-level `project.with(...)` or
  `project.mixin(...)` reaches every matching child. Package predicates live in
  `project.ts` under an exported `predicate` namespace, as plain callable
  `@dbx-tools/shared-core` predicates (narrowing a construct):
  `predicate.hasName("*/shared-core", ...)` (npm name glob via `match.toPathMatcher`,
  `→ Project`), `predicate.hasTag(tag, ...tags)` (all tags required,
  `→ DBXToolsProject`), and `predicate.inRelPath("workspaces", ...)` (root-relative
  folder prefix, `→ Project`). Compose them with `.and()`/`.or()`/`.negate()` - e.g.
  `predicate.hasName("*/shared-core").and(predicate.hasTag("node"))` - keeping
  `predicate.hasTag` in the same `.and(...)` (or last when chaining) so its
  `DBXToolsProject` narrowing survives (a later non-tag `.and` re-widens to `Project`).
  Build the mixin with `mixin(predicate, consumer)` (`mixin.ts`) and hand it to
  `project.with(...)`; `DBXToolsNodeProject.mixin(predicate, consumer)` is chainable
  sugar over exactly that. A `FileBase` guard as the predicate targets any generated file. The root
  applies the built-in tag mixins (**`WORKSPACE_TAG_MIXINS`**,
  `tags.ts`) during its own construction, selected by the `defaultTagMixins` option
  (omit = all, `false` = none, or a subset list) - e.g. the `server` mixin adds
  `express`/`tsoa` + `dev`/`start` tasks. Consumers apply their own AFTER
  construction with `project.mixin(...)` (see `.projenrc.ts`), so user mixins run
  after the defaults.
- **Names**: `pkg.packageNameFor(relPath)` → `PackageIdentifier.of(scope, relPath)`
  (`project.ts`): normalized, lowercased, the root-relative path dash-joined as
  `@<scope>/<seg-seg-...>` (e.g. `workspaces/shared/core` → `@dbx-tools/shared-core`,
  `workspaces/cli/dbx-tools` → `@dbx-tools/cli-dbx-tools`). The `scope` option
  defaults to the resolved project `name`; the `name` option, if omitted, is
  auto-detected (git remote → folder name). This repo passes `scope: "dbx-tools"`,
  giving `@dbx-tools/*` packages. The engine keeps its derived name UNLESS
  overridden — which it is, to the clean `@dbx-tools/cli` (see Gotchas).

## Layout

```
.projenrc.ts                              # new DBXToolsNodeProject({...}) + user mixins + the dbxtools root task
workspaces/
  cli/dbx-tools/                          # the CLI package (`dbx-tools` / `@dbx-tools/cli`)
    bin/dbxtools.ts                       # commander entry: sync | barrels | openapi | clean
    bin/publish.ts                        # projen release tasks (pack / publish / CI)
    index.ts                              # CLI helpers + re-export of `@dbx-tools/shared-projen`
    src/
      bin.ts, log.ts                      # pnpm/bin resolution + consola logger (CLI runtime)
      engine.ts                           # re-export barrel for the projen engine public API
      name.ts, collection.ts              # other CLI helpers
  shared/projen/                          # the projen engine (`@dbx-tools/shared-projen`)
    index.ts                              # generated barrel (public API surface)
    src/
      project.ts                          # DBXToolsProject + DBXToolsNode/TypeScriptProject + PackageIdentifier/naming, applyCompilerOptions/applyTasks, SHARED_COMPILER_OPTIONS, root init
      mixin.ts                            # mixin() factory (tag table lives in tags.ts)
      pnpm-workspace.ts                   # DBXToolsPNPMWorkspace (YamlFile) + IPnpmWorkspace + Catalog/DEFAULT_CATALOG
      tags.ts                             # WORKSPACE_TAG_MIXINS (one IMixin per tag) + AGNOSTIC_COMPILER_OPTIONS
      workspace.ts                        # discovery: scanPackages (fs) + workspacePackages (pnpm-yaml + manifest)
      barrels.ts                          # barrelsby driver (root index.ts, header + read-only)
      watch.ts                            # generic file-watch util (watchLoop + watchRoots) the sync --watch task watchers forward to
      scaffold.ts                         # packageSetChanged() + runSynth({ post })
      bootstrap.ts                        # bootstraps a COMPLETELY EMPTY folder (see Commands)
      openapi.ts                          # openapi generator (tsoa controllers -> spec + client)
      clean.ts, generated.ts, files.ts, vite.ts
  openapi/<name>/                        # generated from tsoa controllers, same root as the source
example-workspaces/
  cli/main/ server/api/ shared/core/ shared/fun/ shared/neat/ ui/app/   # seed examples, each a real subproject
```

## Commands (the `dbxtools` CLI)

```sh
pnpm install                 # link workspace + engine
pnpm exec projen             # synth all generated config (+ install + barrels)
pnpm exec projen sync --watch # watch while editing (concurrently: projenrc + barrels + openapi watchers)
pnpm dbxtools sync           # bootstrap an empty folder, OR re-synth an existing workspace (one-shot)
pnpm dbxtools sync --watch   # watch: projenrc re-synth (.projenrc.ts only) + barrels + openapi watchers, via concurrently
pnpm dbxtools barrels        # rebuild every package's root index.ts barrel
pnpm -r compile              # type-check every package (projen's per-package compile: tsc --build)
pnpm dbxtools openapi        # generate the openapi packages from tsoa controllers
pnpm dbxtools clean          # remove generated files (read-only ones); interactive picker, -y to skip
```

- **`projen sync --watch` is the always-on watcher** (the generated `sync` task run
  with `--watch`, also the VS Code folder-open task). `sync`'s `receiveArgs` forwards
  `--watch` to `tasks/sync.ts`, which does ONE initial full synth, then runs three
  focused watchers under `concurrently` - each its own task script sharing the generic
  `watchLoop`/`watchRoots` (`watch.ts`), each keyed to the smallest input that can
  invalidate its output: `tasks/projenrc.ts` (watches `.projenrc.ts` plus any
  `syncResynthPaths` from the root project option, persisted as
  `dbxToolsConfig.syncResynthPaths`; on edit runs a full re-synth + install - the
  intelligent stand-in for stock `projen --watch`, which re-synths on ANY tree change),
  `tasks/barrels.ts --watch` (a source edit rebuilds just that package's barrel), and
  `tasks/openapi.ts --watch` (a changed tsoa controller regenerates the openapi
  packages). The concern-specific glue lives in the task; `watch.ts` only owns the
  shared debounce/serialize/ignore-generated/SIGINT machinery. Touch `.projenrc.ts`
  (or a listed `syncResynthPaths` file) to force a re-synth for a structural change
  it doesn't spell out (e.g. a new package folder). Stock `projen --watch` is
  deliberately NOT used: it `fs.watch`es the whole repo recursively and re-synths
  (full post, so it installs) on EVERY file change, so a mere source edit forced a
  full re-synth + install.
- **`dbxtools sync` on a completely empty folder bootstraps it** (`bootstrap.ts`):
  `pnpm init`, seed a minimal `pnpm-workspace.yaml` (so the very next step can
  approve `tsx`'s `esbuild` build script non-interactively), `pnpm add -D
projen typescript@^5.9.3 tsx@^4.23.0 <engine specifier>`, write a minimal
  `.projenrc.ts` if none exists, synth (`post: false` - skips projen's own
  post-synth install, which has no non-interactive answer for "remove this
  stale node_modules?" with no TTY), then reconcile the install itself
  (`pnpm install --no-frozen-lockfile --force` - `--force` is what makes pnpm's
  own confirmation logic treat that prompt as pre-answered) and regenerate
  barrels. Scaffolds **no** package folders or sample code - just enough for
  `pnpm exec projen`/`dbxtools sync` to work from here on.
- **`dbxtools sync` on an existing workspace** just runs projen once (full synth,
  installs, regenerates barrels via the post-synth component).
- **`dbxtools sync --watch`** forwards to `projen sync --watch`, which does one
  initial full synth, then (via `concurrently`) runs the projenrc watcher alongside
  the barrel + openapi watchers. The projenrc watcher re-synths (+install) when
  `.projenrc.ts` or a configured `syncResynthPaths` entry changes; the barrel watcher
  rebuilds just the edited package's barrel, and the openapi watcher regenerates the
  `openapi` packages when a tsoa controller changes.
- **Barrels regenerate on every full (post) synth**: a post-synth projen `Component`
  (`GeneratedBarrels` in `project.ts`) runs on any `runSynth({ post: true })` - the
  plain `pnpm exec projen`, `sync`'s initial synth, and the projenrc watcher's
  re-synth all install and rebuild barrels through it. Fast paths skip it: the
  standalone barrel watcher calls `generateBarrels()` directly on edits (no synth),
  and `bootstrap` runs `runSynth` with `PROJEN_DISABLE_POST` set, doing its own
  install + barrels afterward.
- **`dbxtools clean`** (`clean.ts`) deletes generated files. It doesn't hardcode a
  list: every file the toolchain writes is read-only (see below), so a read-only file
  under the repo (skipping vendor/build/VCS, but INCLUDING `.projen/*`) is a clean
  target. It shows a `@clack/prompts` picker with all files preselected (uncheck to
  keep); `-y` removes them all non-interactively. Safe to run - `.projenrc.ts` imports
  the engine by SOURCE path, so `npx tsx .projenrc.ts` (or `pnpm exec projen`)
  regenerates everything afterward.

Barrels re-export every exporting file under `src/` except names starting with
`_`; a package's barrel lives at its ROOT (`index.ts`), re-exporting `./src/*`.

## Generated files — DO NOT edit by hand

- **Per-package** (`package.json`, `tsconfig.json`, `.projen/*`, `README.md`,
  `.gitignore`, …): owned by that package's projen subproject.
- **Root** (root `tsconfig*.json`, `.vscode/*`, per-package `vite.config.ts`):
  read-only + projen marker, emitted from `files.ts`. `pnpm-workspace.yaml` is the
  `DBXToolsPNPMWorkspace` component (`pnpm-workspace.ts`).
- **barrels** (`<root>/<tags...>/<name>/index.ts`): read-only, do-not-edit header,
  written by barrelsby. Marked generated in `.gitattributes` (`annotateGenerated`).
- **openapi** (`<root>/openapi/<name>/`): fully generated from tsoa
  controllers - spec, types, and client.

Change a tag, a hook, or `.projenrc.ts` and re-synth — never edit generated files.

## Gotchas

- **pnpm v11** gates build scripts behind `allowBuilds` in `pnpm-workspace.yaml`
  (NOT `onlyBuiltDependencies`) — `esbuild: true` is the default. Add allowances
  via `project.pnpmWorkspace?.allowBuild(name)` (or `.addCatalog`/`.addPackages`, or
  `file.addOverride(...)` for any other pnpm setting), not by editing the YAML.
- **The engine is dogfooded as a normal auto-discovered package**, not a hand-
  authored special case: it lives at `workspaces/cli/dbx-tools` (tag `cli`,
  name `dbx-tools`), which auto-discovery would otherwise render as
  `@dbx-tools/cli-dbx-tools`. `.projenrc.ts` applies (via `project.mixin(...)`) a
  mixin matching `predicate.hasName("*/cli-dbx-tools").and(predicate.hasTag("cli"))` that:
  overrides the name to `@dbx-tools/cli` (`p.package.addField("name", ...)`),
  adds its bin (`p.package.addBin({ dbxtools: "./bin/dbxtools.ts" })`), depends on
  `@dbx-tools/shared-projen`, and bumps its tsconfig to ES2022 lib/target +
  `rootDir: "."` - extra includes for `index.ts`/`bin/**/*.ts` (the `cli` tag's
  defaults are ES2020 + `src/**/*.ts` only, which doesn't cover code outside
  `src/`). The projen engine itself lives in `workspaces/shared/projen`
  (`@dbx-tools/shared-projen`); a `shared`/`projen` mixin adds its deps
  (`projen`, `constructs`, `barrelsby`, `@dbx-tools/shared-file-scan`, ...).
- **The root keeps the engine itself resolvable across synths** via
  `engineSelfDependency()` (`project.ts`): resolves the `@dbx-tools/cli`
  package (`dbx-tools`) via `require.resolve` when installed; if that
  path passes through a `node_modules` segment (an installed/external
  consumer), it adds that name as a root devDep - reusing WHATEVER specifier is
  already in the consumer's current `package.json` for it (`file:`, `link:`, a
  version, anything) rather than computing one, since overwriting a `file:`/
  `link:` install with a version range would silently repoint it at the
  registry. If the path does NOT pass through `node_modules` (this repo's own
  dogfooding - relative-imported, no package resolution involved), it returns
  `undefined` and adds nothing. The root also adds `tsx`, `typescript`, and
  `@types/node`.
- **`DBXToolsNodeProject` defaults `packageManager: PNPM`** (projen's
  `packageManager` is readonly after construction); pass a different one only if
  you know what you're doing, since the whole toolchain assumes pnpm workspaces.
- **Type-checking is projen's own per-package `compile`** (`tsc --build` against
  each package's tag tsconfig), not a `dbxtools` command - the tag `lib`/`types`
  overrides are what make misuse fail. Check one package with `pnpm exec projen
compile` (or `pnpm compile`) in its dir, or all of them with `pnpm -r compile`.
- **Tool bins are resolved lazily** (a memoized function, not a module-level
  const): `barrels.ts` resolves barrelsby this way. Resolving eagerly broke merely
  _importing_ the engine (which the barrel pulls in) whenever a consumer's install
  of that tool was an unusual version with a narrower `exports` map.
- Repo is `type: module`. Packages get a `module: ESNext` + `moduleResolution:
bundler` overlay (`SHARED_COMPILER_OPTIONS` in `project.ts`) because projen's
  default `module: CommonJS` breaks the ESM sources' `import.meta`; `bundler`
  honors the `exports` map, so a bare `@dbx-tools/<pkg>` import resolves to that
  package's ROOT `index.ts` barrel — packages type-check against each other with
  no build step. Cross-package imports still need the workspace dep declared
  (`p.addDeps("@dbx-tools/shared-core@workspace:*")` in a `project.mixin(...)`) and MUST
  use the package name (`@dbx-tools/shared-file-scan`), never a relative path into
  another package's `src/` (e.g. `../../../../shared/file-scan/src/find`).
- Everything runs on portable Node: subprocesses use `execFileSync(process.execPath, …)`;
  read-only is `fs.chmodSync` (Node maps it to the Windows read-only attribute).
  `bootstrap.ts` resolves `pnpm`'s own CLI the same way (`require.resolve`, not a
  PATH lookup) - `pnpm` is a regular dependency of the engine for exactly this.
- **`package.json` is forced read-only by default** on the root and every
  subproject, so the whole generated tree is consistent. The `DBXToolsConfig`
  component sets the manifest's `FileBase.readonly = true` in its CONSTRUCTOR (projen
  still rewrites the file each synth - clears the bit, writes, restores). Opt a
  package out by setting `p.package.file.readonly = false` directly - done in the
  constructor rather than `preSynthesize` precisely so a later opt-out wins at synth.
  The CLI package does exactly this so its own `package.json` stays writable.
  Source/sample files the developer owns (`.projenrc.ts`, each package's `README.md`,
  `src/*`) stay writable regardless.
- **OpenAPI** (`openapi.ts`, `dbxtools openapi`): scans **every discovered**
  `server`/`node` package for **tsoa** controllers (classes with
  `@Route`/`@Get`/... - no JSDoc/YAML). For each, tsoa's `generateSpec` infers an
  OpenAPI 3 spec from the decorators + TS types, then openapi-typescript +
  openapi-fetch produce a read-only `<sourcePackage root>/openapi/<name>`
  package (`openapi.json` + `src/schema.ts` + `src/client.ts`) - colocated under
  the SAME root as the controller it came from (`example-workspaces/server/
api`'s controllers generate `example-workspaces/openapi/api`), not a hardcoded
  root. tsoa/typescript/openapi-typescript are lazy-loaded (only `dbxtools
openapi` / a watched controller edit needs them). The openapi watcher (started by
  `projen sync --watch`, under `concurrently`) regenerates it automatically when a
  controller changes.
