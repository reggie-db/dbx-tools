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
  (`cli/main`, `server/api`, `shared/core`, `shared/neat`, `ui/app`), kept in a
  separate root so they stay visually distinct from anything you actually build.

> Local dir is `projen-workspace/`; the GitHub repo is `reggie-db/dbx-tools`
> (this work is on branch **`main`**; `master` holds older work and is still the
> default).

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
  defaults (`NODE_ENGINE_DEFAULTS`: pnpm, no jest/eslint/prettier/github/release/
  depsUpgrade, no `devEngines.packageManager` — pnpm 11 errors if that and
  `packageManager` are both set) under anything you pass. You then call
  `project.synth()` yourself. A normal consuming `.projenrc.ts` is two lines:
  `const project = new DBXToolsNodeProject(); project.synth();`. Both classes
  share `DBXToolsCommonOptions` (`scope`, `workspacePackageRoots`,
  `workspacePackageTagPaths`, `workspaceTags`, `disableWorkspaceTags`, `catalog`,
  `tags`, `defaultTagMixins`) and a small `DBXToolsSupport` helper backing the
  surface they expose: `tags` + `appendTag`/`prependTag` (distinct, order-
  preserving, read/written directly on `package.json` `dbxToolsConfig.tags` via
  `NodePackage` — never cached on a field), `scope` + `packageNameFor`, and the
  `pnpmWorkspace` field.
- **`pnpm-workspace.yaml` is the source of truth**, emitted by the
  `DBXToolsPNPMWorkspace` component (`pnpm-workspace.ts`) exposed as the root's
  `project.pnpmWorkspace` field. The root scans the filesystem ONCE at synth
  (under each `workspacePackageRoots` root, default `["workspaces"]`) and the
  file's `packages:` list is sourced from `project.subprojects` at synth via a
  thunk (so member order/timing never matters) — every discovered package becomes
  a real subproject, no manual member list. Mutate it through the typed methods
  `project.pnpmWorkspace.addCatalog(name, version)` / `.allowBuild(name)` /
  `.addPackage(glob)` (or `file.addOverride(...)` for any other pnpm setting), not
  by editing the YAML. Discovery is TWO functions in `workspace.ts`:
  `scanPackages(root, roots)` walks the filesystem (synth time; returns each
  package's path + the tags implied by its path, reading no manifest), while
  `workspacePackages()` reads the recorded members back from `pnpm-workspace.yaml`
  and augments each with the `name` + `tags` from its own `package.json` — what
  every post-synth command (`barrels`, `typecheck`, the watcher, `openapi`) uses.
- **Discovery + tag resolution.** Under each `workspacePackageRoots` root (this
  repo passes `["workspaces", "example-workspaces"]`), ANY `src`-bearing folder at
  ANY depth is a package. Its path relative to the root is decomposed into
  cumulative dash-join **tag candidates**: `ui/app` → `[ui, ui-app]`;
  `dir/another/path` → `[dir, dir-another, dir-another-path]`. Each candidate is
  looked up in **`workspacePackageTagPaths`** (`Record<token, OneOrMany<tag>>`,
  default: identity over the tag names) and the union of matches — together with
  any tags already on a pre-attached project — is the package's applied tags,
  possibly NONE (then only the agnostic default applies). The deduped tag list is
  written to each package's `package.json` under **`dbxToolsConfig.tags`** (the
  per-package source of truth, surfaced post-synth as `workspacePackages()[].tags`)
  and held on the `DBXToolsTypeScriptProject` instance (read via `pkg.tags`, the
  basis a `packageMixin` dispatches on). (`OneOrMany<T> = T | T[]`,
  `workspace.ts`.) No declaration needed — drop a `src/` folder, re-synth.
- **A root may already hold in-tree subprojects.** If a discovered folder matches
  a subproject already attached to the root, it is NOT re-created — the resolved
  tags are unioned onto it (`appendTag` for a DBXTools project, else
  `addWorkspacePackageTags`). The root itself can also carry tags (a `""`/`"."`
  key in `workspacePackageTagPaths`, or the `tags` option).
- **Every package is a `DBXToolsTypeScriptProject`** (extends
  `typescript.TypeScriptProject`). The root's scan constructs one per discovered
  folder with `parent: root`; you can also `new DBXToolsTypeScriptProject({parent,
  ...})` directly to attach a package WITHOUT auto-discovery. Its tags' configs
  are MERGED in order (`mergeTagDefs` in `packages.ts`: deps concatenated,
  `tsconfig.compilerOptions`/`tasks` later-wins, `viteConfig` OR'd) over the
  `DEFAULT_WORKSPACE_TAG` floor and spread into the projen options; the class then
  points `main`/`types`/`exports` at the package-root `index.ts` barrel, applies
  the tag's `tasks`, optionally emits `vite.config.ts`, and locks `package.json`.
  projen OWNS that package's `package.json`/`tsconfig.json`/tasks/`README.md`/
  `.projen/`; baseline projen features are off to match the root (`SUBPROJECT_
  DEFAULTS`; `sampleCode: false` stops projen dropping template `src/` files).
- **Tags are ONE map.** `tags.ts` — `WORKSPACE_TAGS` / `WorkspaceTagDef` (no
  separate "profile" type; `TagDef` is just an alias of the same shape). A
  `WorkspaceTagDef` IS a projen `TypeScriptProject` options bag
  (`Partial<TypeScriptProjectOptions>`) plus two engine-only extras (`tasks`,
  `viteConfig`), spread into the package. So a tag sets projen-native
  `deps`/`devDeps`/`peerDeps` + `tsconfig.compilerOptions` (projen enums, e.g.
  `TypeScriptJsxMode.REACT_JSX`), merged over projen defaults so tag
  `lib`/`jsx`/`types`/`target` win:
  - `ui` → Vite/React (DOM + `vite/client` types, jsx, `vite.config.ts`)
  - `server` → Node (`@types/node`, `tsoa` + `experimentalDecorators`, no DOM)
  - `node` → Node (`@types/node`, no DOM)
  - `cli` → Node + `commander` + `@clack/prompts`
  - `shared` → agnostic (no DOM, no Node)
  - `openapi` → generated, read-only clients (from tsoa controllers)
  Enforcement is real via each package's generated `tsconfig` `lib`/`types`:
  `document` in `shared`/`server` fails `tsc`; `process`/`node:*` in `ui` fails.
- **Per-package behavior is MIXINS** (`mixins.ts`; `constructs` `IMixin`). A mixin
  is `{ supports(c), applyTo(c) }`, applied with the constructs-native
  `construct.with(...mixins)` — it runs each across the construct's whole subtree
  (tree captured at call time), so a root-level `project.with(...)` reaches every
  matching child. `tagMixin(tag, fn)` targets packages carrying `tag`;
  `packageMixin(predicate, fn)` targets packages by any predicate (dispatch on
  `pkg.tags` + `basename(pkg.outdir)`); `fileMixin(fn)` targets any generated
  `FileBase`. The root applies the built-in **`DEFAULT_TAG_MIXINS`** (toggled by
  the `defaultTagMixins` option, `"all"` by default) during its own construction —
  e.g. the `server` mixin adds `express` + `dev`/`start` tasks. Consumers apply
  their own AFTER construction with `project.with(...)` (see `.projenrc.ts`), so
  user mixins run after the defaults.
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
    bin/dbxtools.ts                       # the CLI (commander): sync | watch | barrels | typecheck | openapi
    index.ts                             # generated barrel (public API surface, like any package)
    src/
      log.ts                             # projen-AGNOSTIC utilities live at src/ root
      projen/                            # everything projen-specific lives under src/projen/
        project.ts                       # DBXToolsNodeProject + DBXToolsTypeScriptProject + initDBXToolsProject + post-synth barrels
        mixins.ts                        # tagMixin/packageMixin/fileMixin + DEFAULT_TAG_MIXINS
        pnpm-workspace.ts                # DBXToolsPNPMWorkspace (YamlFile) + Catalog/DEFAULT_CATALOG
        tags.ts                          # WORKSPACE_TAGS map + WorkspaceTagDef/TagDef (the one tag type)
        workspace.ts                     # discovery: scanPackages (fs) + workspacePackages (pnpm-yaml + manifest)
        packages.ts                      # npmNameOf, lockPackageJson, mergeTagDefs, applyTasks, SUBPROJECT/SHARED defaults
        barrels.ts                       # barrelsby driver (root index.ts, header + read-only)
        watch.ts                         # chokidar loop for `dbxtools watch` (package-set re-synth + barrels)
        scaffold.ts                      # packageSetChanged() + runSynth({ post })
        bootstrap.ts                     # bootstraps a COMPLETELY EMPTY folder (see Commands)
        openapi.ts                       # openapi generator (tsoa controllers -> spec + client)
        typecheck.ts, generated.ts, files.ts
  openapi/<name>/                        # generated from tsoa controllers, same root as the source
example-workspaces/
  cli/main/ server/api/ shared/core/ shared/neat/ ui/app/   # seed examples, each a real subproject
```

## Commands (the `dbxtools` CLI)

```sh
pnpm install                 # link workspace + engine
pnpm exec projen             # synth all generated config (+ install + barrels)
pnpm exec projen sync        # keep it in sync while editing (concurrently: projen --watch + dbxtools watch)
pnpm dbxtools sync           # bootstrap an empty folder, OR re-synth an existing workspace (one-shot)
pnpm dbxtools watch          # watch: re-synth on package add/remove, barrels on source edits
pnpm dbxtools barrels        # rebuild every package's root index.ts barrel
pnpm dbxtools typecheck      # tsc --noEmit per package (proves tag enforcement)
pnpm dbxtools openapi        # generate the openapi packages from tsoa controllers
```

- **`projen sync` is the always-on watcher** (the generated `sync` task, also the
  VS Code folder-open task). It runs the watches CONCURRENTLY, with NO env-var
  handshake: `concurrently -k "pnpm exec projen --watch" "pnpm dbxtools watch"`.
  `projen --watch` owns `.projenrc.ts` re-synth (barrels regenerate via the
  post-synth component); `dbxtools watch` owns the rest — see below.
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
- **`dbxtools watch`** starts ONE chokidar process (see `watch.ts`) run ALONGSIDE
  `projen --watch`, covering the two concerns projen's own watch does NOT: a
  package SET change (new/removed `src` folder) → re-synth (+install); a source
  edit in an existing package → rebuild just that package's barrel (no re-synth),
  and if it's a tsoa controller, regenerate the `openapi` packages too. It does
  NOT watch `.projenrc.ts` (projen --watch owns that) or do an initial full
  re-synth (projen --watch's startup synth does).
- **Barrels regenerate on every re-synth**: a post-synth projen `Component`
  (`GeneratedBarrels` in `project.ts`) on the plain `projen` path; `dbxtools`/
  watch's `runSynth` sets `PROJEN_DISABLE_POST` (skipping the component for speed)
  and call `generateBarrels()` explicitly.

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
  via `project.pnpmWorkspace.allowBuild(name)` (or `.addCatalog`/`.addPackage`, or
  `file.addOverride(...)` for any other pnpm setting), not by editing the YAML.
- **The engine is dogfooded as a normal auto-discovered package**, not a hand-
  authored special case: it lives at `workspaces/cli/dbx-tools` (tag `cli`,
  name `dbx-tools`), which auto-discovery would otherwise render as
  `@dbx-tools/cli-dbx-tools`. `.projenrc.ts` applies (via `project.with(...)`) a
  `packageMixin` matching
  `p.tags.includes("cli") && basename(p.outdir) === "dbx-tools"` that:
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
  `undefined` and adds nothing. The root also adds `concurrently` (for the `sync`
  task), `tsx`, `typescript`, `@types/node`.
- **`DBXToolsNodeProject` defaults `packageManager: PNPM`** (projen's
  `packageManager` is readonly after construction); pass a different one only if
  you know what you're doing, since the whole toolchain assumes pnpm workspaces.
- **`typecheck.ts` resolves `typescript/bin/tsc` lazily** (memoized function,
  not a module-level const) - like `barrels.ts` already does for barrelsby.
  Resolving it eagerly broke merely *importing* the engine (which pulls in
  `typecheck.ts` via the barrel) whenever a consumer's `typescript` install
  happened to be an unusual version with a narrower `exports` map.
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
- **`package.json` is forced read-only** via `lockPackageJson` (`packages.ts`) on
  the root and every subproject, so the whole generated tree is consistent. projen
  still rewrites it each synth (clears the bit, writes, restores). Source/sample
  files the developer owns (`.projenrc.ts`, each package's `README.md`, `src/*`)
  stay writable.
- **OpenAPI** (`openapi.ts`, `dbxtools openapi`): scans **every discovered**
  `server`/`node` package for **tsoa** controllers (classes with
  `@Route`/`@Get`/... - no JSDoc/YAML). For each, tsoa's `generateSpec` infers an
  OpenAPI 3 spec from the decorators + TS types, then openapi-typescript +
  openapi-fetch produce a read-only `<sourcePackage root>/openapi/<name>`
  package (`openapi.json` + `src/schema.ts` + `src/client.ts`) - colocated under
  the SAME root as the controller it came from (`example-workspaces/server/
  api`'s controllers generate `example-workspaces/openapi/api`), not a hardcoded
  root. tsoa/typescript/openapi-typescript are lazy-loaded (only `dbxtools
  openapi` / a watched controller edit needs them). `dbxtools watch` (started by
  `projen sync`) regenerates it automatically when a controller changes.
