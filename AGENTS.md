# AGENTS.md

Orientation for AI agents / new contributors. Read this first.

## What this repo is

A **projen-driven pnpm monorepo generator**. The reusable engine is its own
package, **`@dbx-tools/cli`**, dogfooded in this repo at
**`workspaces/cli/dbx-tools`** as a normal auto-discovered package (not a
special case). It exports two projen project subclasses —
**`DBXToolsNodeProject`** (the monorepo root) and **`DBXToolsTypeScriptProject`**
(a package) — plus the **mixin** helpers (`tagMixin`/`packageMixin`/`fileMixin`)
for per-package tweaks, and ships the **`dbxtools`** CLI.

- **`workspaces/`** — real content goes here.
- **`example-workspaces/`** — the seed example packages this repo ships
  (`cli/main`, `server/api`, `shared/core`, `shared/fun`, `shared/neat`, `ui/app`),
  kept in a separate root so they stay visually distinct from anything you build.

> Local dir is `dbx-tools/`; the GitHub repo is `reggie-db/dbx-tools`
> (default branch **`main`**).

## Vocabulary (important)

- **tag** — a label a workspace package carries (Bit-style; it names the target
  *environment* — React/Vite, Node, agnostic, …). A package can carry MANY tags,
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
  are top-level options, not nested fields. Both expose `IDBXToolsProject`:
  `scope`/`packageNameFor` plus the nested config COMPONENTS as fields (projen-style,
  like `project.eslint?.addRules(...)`) — `project.dbxToolsConfig` (implements
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
  basis a `packageMixin` dispatches on). No declaration needed — drop a `src/`
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
- **Per-package behavior is MIXINS** (`mixins.ts`; `constructs` `IMixin`). A mixin
  is `{ supports(c), applyTo(c) }`, applied with the constructs-native
  `construct.with(...mixins)` — it runs each across the construct's whole subtree
  (tree captured at call time), so a root-level `project.with(...)` reaches every
  matching child. `tagMixin(tag, fn)` targets packages carrying `tag`;
  `packageMixin(predicate, fn)` targets packages by any predicate (dispatch on
  `pkg.dbxToolsConfig.tags` + `basename(pkg.outdir)`); `fileMixin(fn)` targets any generated
  `FileBase`. The root applies the built-in tag mixins (**`WORKSPACE_TAG_MIXINS`**,
  `tags.ts`) during its own construction, selected by the `defaultTagMixins` option
  (omit = all, `false` = none, or a subset list) - e.g. the `server` mixin adds
  `express`/`tsoa` + `dev`/`start` tasks. Consumers apply their own AFTER
  construction with `project.with(...)` (see `.projenrc.ts`), so user mixins run
  after the defaults.
- **Names**: `pkg.packageNameFor(relPath)` → `npmNameOf(scope, relPath)`
  (`packages.ts`): normalized, lowercased, the root-relative path dash-joined as
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
  cli/dbx-tools/                          # the engine itself, DOGFOODED as a normal cli package
    bin/dbxtools.ts                       # the CLI (commander): sync[--watch] | barrels | openapi | clean
    index.ts                             # generated barrel (public API surface, like any package)
    src/
      log.ts                             # projen-AGNOSTIC utilities live at src/ root
      projen/                            # everything projen-specific lives under src/projen/
        project.ts                       # DBXToolsNode/TypeScriptProject + ITagging/IPnpmWorkspace + DBXToolsConfig + initDBXToolsProject
        mixins.ts                        # tagMixin/packageMixin/fileMixin (mixin factories; tag table lives in tags.ts)
        pnpm-workspace.ts                # DBXToolsPNPMWorkspace (YamlFile) + IPnpmWorkspace + Catalog/DEFAULT_CATALOG
        tags.ts                          # WORKSPACE_TAG_MIXINS (one IMixin per tag) + AGNOSTIC_COMPILER_OPTIONS
        workspace.ts                     # discovery: scanPackages (fs) + workspacePackages (pnpm-yaml + manifest)
        packages.ts                      # npmNameOf, lockPackageJson, applyCompilerOptions, applyTasks, addWorkspacePackageTags, SHARED_COMPILER_OPTIONS
        barrels.ts                       # barrelsby driver (root index.ts, header + read-only)
        watch.ts                         # chokidar loop for `dbxtools sync --watch` (package-set re-synth + barrels)
        scaffold.ts                      # packageSetChanged() + runSynth({ post })
        bootstrap.ts                     # bootstraps a COMPLETELY EMPTY folder (see Commands)
        openapi.ts                       # openapi generator (tsoa controllers -> spec + client)
        clean.ts, generated.ts, files.ts, vite.ts
  openapi/<name>/                        # generated from tsoa controllers, same root as the source
example-workspaces/
  cli/main/ server/api/ shared/core/ shared/fun/ shared/neat/ ui/app/   # seed examples, each a real subproject
```

## Commands (the `dbxtools` CLI)

```sh
pnpm install                 # link workspace + engine
pnpm exec projen             # synth all generated config (+ install + barrels)
pnpm exec projen sync --watch # keep it in sync while editing (runs the single dbxtools watch loop)
pnpm dbxtools sync           # bootstrap an empty folder, OR re-synth an existing workspace (one-shot)
pnpm dbxtools sync --watch   # sync, then watch: re-synth on .projenrc.ts/package changes, barrels on edits
pnpm dbxtools barrels        # rebuild every package's root index.ts barrel
pnpm -r compile              # type-check every package (projen's per-package compile: tsc --build)
pnpm dbxtools openapi        # generate the openapi packages from tsoa controllers
pnpm dbxtools clean          # remove generated files (read-only ones); interactive picker, -y to skip
```

- **`projen sync --watch` is the always-on watcher** (the generated `sync` task run
  with `--watch`, also the VS Code folder-open task). `sync`'s `receiveArgs` forwards
  `--watch` to `dbxtools sync --watch`, which syncs once then runs the SINGLE
  `dbxtools watch` loop. projen's own `--watch` is deliberately NOT used (and never
  collides — it only fires for the bare `projen` synth, not a named task): it
  `fs.watch`es the whole repo recursively and re-runs `.projenrc.ts` on EVERY file
  change, so a mere source edit forced a full re-synth. The watcher re-synths only
  when needed — see below.
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
- **`dbxtools sync --watch`** syncs once, then starts ONE chokidar process (see
  `watch.ts`) - the SINGLE watcher - covering three concerns: a `.projenrc.ts` edit →
  full re-synth (+install, deps may change); a package SET change (new/removed `src`
  folder) → re-synth (+install); a source edit in an existing package → rebuild just
  that package's barrel (no re-synth), and if it's a tsoa controller, regenerate the
  `openapi` packages too. The initial sync is the `sync` step, so the watcher itself
  just watches.
- **Barrels regenerate on every re-synth**: a post-synth projen `Component`
  (`GeneratedBarrels` in `project.ts`) on the plain `projen` path; `dbxtools`/
  watch's `runSynth` sets `PROJEN_DISABLE_POST` (skipping the component for speed)
  and call `generateBarrels()` explicitly.
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
  `@dbx-tools/cli-dbx-tools`. `.projenrc.ts` applies (via `project.with(...)`) a
  `packageMixin` matching
  `p.dbxToolsConfig.tags.includes("cli") && basename(p.outdir) === "dbx-tools"` that:
  overrides the name to `@dbx-tools/cli` (`p.package.addField("name", ...)`),
  adds its bin (`p.package.addBin({ dbxtools: "./bin/dbxtools.ts" })`), adds its
  own deps (`projen`, `constructs`, `barrelsby`, `chokidar`, `consola`,
  `openapi-typescript`, `tsoa`, `yaml`, `tsx`, `pnpm` - `commander` already comes
  from the `cli` tag), and bumps its tsconfig to ES2022 lib/target + `rootDir: "."`
  + extra includes for `index.ts`/`bin/**/*.ts` (the `cli` tag's defaults are
  ES2020 + `src/**/*.ts` only, which doesn't cover `Object.hasOwn` in `log.ts`
  or anything outside `src/`).
- **The root keeps the engine itself resolvable across synths** via
  `engineSelfDependency()` (`project.ts`): reads the engine's OWN nearby
  `package.json` (two directories up from `project.ts`) for its name; if that
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
  *importing* the engine (which the barrel pulls in) whenever a consumer's install
  of that tool was an unusual version with a narrower `exports` map.
- Repo is `type: module`. Packages get a `module: ESNext` + `moduleResolution:
  bundler` overlay (`SHARED_COMPILER_OPTIONS` in `packages.ts`) because projen's
  default `module: CommonJS` breaks the ESM sources' `import.meta`; `bundler`
  honors the `exports` map, so a bare `@dbx-tools/<pkg>` import resolves to that
  package's ROOT `index.ts` barrel — packages type-check against each other with
  no build step. Cross-package imports still need the workspace dep declared
  (`p.addDeps("@dbx-tools/shared-core@workspace:*")` in a `packageMixin`).
- Everything runs on portable Node: subprocesses use `execFileSync(process.execPath, …)`;
  read-only is `fs.chmodSync` (Node maps it to the Windows read-only attribute).
  `bootstrap.ts` resolves `pnpm`'s own CLI the same way (`require.resolve`, not a
  PATH lookup) - `pnpm` is a regular dependency of the engine for exactly this.
- **`package.json` is forced read-only by default** on the root and every
  subproject, so the whole generated tree is consistent. The switch is the
  `DBXToolsConfig` component's `lockPackageJson` (default `true`), applied in its
  `preSynthesize` via `lockPackageJson()` (`packages.ts`); projen still rewrites the
  file each synth (clears the bit, writes, restores). Opt a package out with
  `p.dbxToolsConfig.lockPackageJson = false` (or the `lockPackageJson: false`
  option) - the engine package does exactly this so its own `package.json` stays
  writable. Source/sample files the developer owns (`.projenrc.ts`, each package's
  `README.md`, `src/*`) stay writable regardless.
- **OpenAPI** (`openapi.ts`, `dbxtools openapi`): scans **every discovered**
  `server`/`node` package for **tsoa** controllers (classes with
  `@Route`/`@Get`/... - no JSDoc/YAML). For each, tsoa's `generateSpec` infers an
  OpenAPI 3 spec from the decorators + TS types, then openapi-typescript +
  openapi-fetch produce a read-only `<sourcePackage root>/openapi/<name>`
  package (`openapi.json` + `src/schema.ts` + `src/client.ts`) - colocated under
  the SAME root as the controller it came from (`example-workspaces/server/
  api`'s controllers generate `example-workspaces/openapi/api`), not a hardcoded
  root. tsoa/typescript/openapi-typescript are lazy-loaded (only `dbxtools
  openapi` / a watched controller edit needs them). The watcher (started by
  `projen sync --watch`) regenerates it automatically when a controller changes.
