# AGENTS.md

Orientation for AI agents / new contributors. Read this first.

## What this repo is

A **projen-driven pnpm monorepo generator**. The reusable engine is its own
package, **`@dbx-tools/cli`**, dogfooded in this repo at
**`workspaces/cli/dbx-tools`** as a normal auto-discovered package (not a
special case). It exports **`configureProject(project?, options?)`** and ships
the **`dbxtools`** CLI.

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

- **`configureProject(project?, options?)` gives you a configured monorepo.**
  The first arg is optional: pass your own `NodeProject` to configure it in
  place, or omit it and the engine constructs one, merging its opinionated
  defaults (`ENGINE_DEFAULTS` in `configure.ts`: pnpm, no
  jest/eslint/prettier/github/release/depsUpgrade, no `devEngines.packageManager`
  — pnpm 11 errors if that and `packageManager` are both set) with an optional
  `options.extends: Partial<NodeProjectOptions>` (anything the caller sets there
  wins; anything left `undefined` falls back to the engine's default). It
  **returns the project**, and — unless `options.synth === false` — calls
  `project.synth()` for you (`synth` defaults to `true`). A normal consuming
  `.projenrc.ts` is therefore one line: `configureProject();`. This repo passes
  `synth: false` only because it adds a `dbxtools` root task after configuring,
  then synths manually (see `.projenrc.ts` + Gotchas).
- **`pnpm-workspace.yaml` is the source of truth.** `configureProject` scans the
  filesystem ONCE at synth (under each `workspacePackageRoots` root, default
  `["workspaces"]`) and its `packages:` list is sourced from `project.subprojects`
  (every discovered package becomes a real subproject, so this needs no
  separate/manual member list). Every other command (`barrels`, `typecheck`, the
  watcher) reads it back via `discoverPackages()` (no args) — see `workspace.ts` —
  rather than re-scanning the tree. Passing `discoverPackages(root, roots)` is the
  filesystem scan; passing nothing reads the recorded truth.
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
  per-package source of truth, read back by post-synth commands via
  `packageTags()`) and passed to the hook via `spec.tags`. (`OneOrMany<T> =
  T | T[]`, `workspace.ts`.) No declaration needed — drop a `src/` folder and it's
  picked up on next synth.
- **A root you pass may already hold in-tree subprojects.** If a discovered
  folder matches a subproject already attached to `project`, `configureProject`
  does NOT re-create it — it just unions the resolved tags onto it
  (`addWorkspacePackageTags`). The root project itself can also carry tags (via a
  `""`/`"."` key in `workspacePackageTagPaths`).
- **Every package is a real projen subproject**, built by the exported
  `applyTags(parent, {outdir, name, config, tags?, defaultModifiers?, spec?,
  workspacePackage?})` primitive (`packages.ts`), where `config` is
  `OneOrMany<TagDef>` — multiple tag defs are MERGED in order (deps concatenated,
  `tsconfig.compilerOptions`/`tasks` later-wins, `viteConfig` OR'd) over the
  `DEFAULT_WORKSPACE_TAG` floor. `configureProject` calls it once per discovered
  folder; a `.projenrc.ts` can also call it directly to configure a path WITHOUT
  auto-discovery. Either way projen OWNS that package's
  `package.json`/`tsconfig.json`/tasks/`README.md`/`.projen/`. Baseline projen
  features are off to match the root (`sampleCode: false` stops projen from
  dropping template `src/` files over real sources).
- **Tags are ONE map.** `tags.ts` — `WORKSPACE_TAGS` / `WorkspaceTagDef` (no
  separate "profile" type; `TagDef` is just an alias of the same shape for
  `applyTags`'s manual-configuration case). A `WorkspaceTagDef` IS a projen
  `TypeScriptProject` options bag (`Partial<TypeScriptProjectOptions>`) plus two
  engine-only extras (`tasks`, `viteConfig`); `applyTags` spreads it into the
  subproject. So a tag sets projen-native `deps`/`devDeps`/`peerDeps` +
  `tsconfig.compilerOptions` (projen enums, e.g. `TypeScriptJsxMode.REACT_JSX`),
  merged over projen defaults so tag `lib`/`jsx`/`types`/`target` win:
  - `ui` → Vite/React (DOM + `vite/client` types, jsx, `vite.config.ts`)
  - `server` → Node (`@types/node`, `tsoa` + `experimentalDecorators`, no DOM)
  - `node` → Node (`@types/node`, no DOM)
  - `cli` → Node + `commander` + `@clack/prompts`
  - `shared` → agnostic (no DOM, no Node)
  - `openapi` → generated, read-only clients (from tsoa controllers)
  Enforcement is real via each package's generated `tsconfig` `lib`/`types`:
  `document` in `shared`/`server` fails `tsc`; `process`/`node:*` in `ui` fails.
- **Default tag modifiers + the deferred pass.** Beyond the config a tag
  contributes to the subproject, some tags carry a built-in *modifier* — imperative
  projen calls keyed by tag in `DEFAULT_WORKSPACE_PACKAGE_MODIFIERS` (`packages.ts`;
  e.g. the `server` modifier adds `express` + `dev`/`start` tasks). Which run is
  controlled by **`workspacePackageDefaults`** (`"all"` — the default — or a list
  of tag names). These run in a DEFERRED pass, AFTER every package (and the root)
  is configured, and the caller's **`workspacePackage`** hook runs LAST of all.
- **Names**: `npmNameOf(scope, p.relPath)` (`packages.ts`) → normalized,
  lowercased, the root-relative path dash-joined as `@<scope>/<seg-seg-...>` (e.g.
  `workspaces/shared/core` → `@dbx-tools/shared-core`, `workspaces/cli/dbx-tools`
  → `@dbx-tools/cli-dbx-tools`). The npm scope is the resolved project name:
  `configureProject`'s `name` option is optional and, if omitted, auto-detected
  (git remote → folder name). So this repo (no explicit `name`) resolves to
  `dbx-tools`, giving `@dbx-tools/*` packages. The engine keeps its derived name
  UNLESS overridden - which it is, to the clean `@dbx-tools/cli` (see Gotchas).
- **No per-package config in `.projenrc.ts`.** Everything is auto-detected; the
  only place per-package tweaks belong is **`workspacePackage(pkg, spec)`**. `pkg`
  is the REAL subproject and the only thing you mutate — use projen's API
  (`pkg.addDeps("x@catalog:")`, `pkg.addTask(...)`, `pkg.package.addBin({...})`,
  `pkg.tsconfig?.addInclude(...)`, `pkg.tsconfig?.file.addOverride(...)`).
  `spec` is read-only identity (`WorkspacePackageSpec`); dispatch on the stable
  folder — **`spec.tags`** (a list; use `.includes("cli")`) + `spec.name` (e.g.
  `"main"`) — not the derived `packageName`.
- **`onGeneratedFile(file, project)`** (option) is called once per generated
  projen `FileBase` across the root and every subproject in the deferred pass —
  a hook to inspect or tweak generated files (barrelsby-written barrels aren't
  projen files, so they're not included).

## Layout

```
.projenrc.ts                              # configureProject(undefined, {...}) + the dbxtools root task
workspaces/
  cli/dbx-tools/                          # the engine itself, DOGFOODED as a normal cli package
    bin/dbxtools.ts                       # the CLI (commander): sync [--watch] | barrels | typecheck | openapi
    index.ts                             # generated barrel (public API surface, like any package)
    src/
      log.ts                             # projen-AGNOSTIC utilities live at src/ root
      projen/                            # everything projen-specific lives under src/projen/
        configure.ts                     # configureProject(project?, options?) + engineSelfDependency + post-synth barrels
        tags.ts                          # WORKSPACE_TAGS map + WorkspaceTagDef/TagDef (the one tag type)
        workspace.ts                     # discovery: DiscoveredPackage + discoverPackages (fs | pnpm-yaml)
        packages.ts                      # applyTags -> TypeScriptProject subproject + default tag modifiers
        barrels.ts                       # barrelsby driver (root index.ts, header + read-only)
        watch.ts                         # chokidar orchestration for `sync --watch`
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
pnpm dbxtools sync           # bootstrap an empty folder, OR re-synth an existing workspace
pnpm dbxtools sync --watch   # watch: re-synth on config/package changes, barrels on edits
pnpm dbxtools barrels        # rebuild every package's root index.ts barrel
pnpm dbxtools typecheck      # tsc --noEmit per package (proves tag enforcement)
pnpm dbxtools openapi        # generate the openapi packages from tsoa controllers
pnpm exec projen watch       # projen's watch task -> `pnpm dbxtools sync --watch`
```

- **`sync` on a completely empty folder bootstraps it** (`bootstrap.ts`):
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
- **`sync` on an existing workspace** just runs projen (full synth, installs,
  regenerates barrels via the post-synth component).
- **`sync --watch`** starts ONE chokidar process (see `watch.ts`) folding three
  concerns: config edit (`.projenrc.ts` / in-tree engine `src`) → re-synth;
  package SET change (new/removed `src` folder) → re-synth (+install); source
  edit in an existing package → rebuild just that package's barrel (and, if it's
  a tsoa controller, regenerate the `openapi` packages too).
- **Barrels regenerate on every re-synth**: a post-synth projen `Component` on the
  plain `projen` path; `dbxtools`/watch set `PROJEN_DISABLE_POST` (skipping the
  component for speed) and call `generateBarrels()` explicitly.

Barrels re-export every exporting file under `src/` except names starting with
`_`; a package's barrel lives at its ROOT (`index.ts`), re-exporting `./src/*`.

## Generated files — DO NOT edit by hand

- **Per-package** (`package.json`, `tsconfig.json`, `.projen/*`, `README.md`,
  `.gitignore`, …): owned by that package's projen subproject.
- **Root** (`pnpm-workspace.yaml`, root `tsconfig*.json`, `.vscode/*`, per-package
  `vite.config.ts`): read-only + projen marker, emitted from `files.ts`.
- **barrels** (`<root>/<tags...>/<name>/index.ts`): read-only, do-not-edit header,
  written by barrelsby. Marked generated in `.gitattributes` (`annotateGenerated`).
- **openapi** (`<root>/openapi/<name>/`): fully generated from tsoa
  controllers - spec, types, and client.

Change a tag, a hook, or `.projenrc.ts` and re-synth — never edit generated files.

## Gotchas

- **pnpm v11** gates build scripts behind `allowBuilds` in `pnpm-workspace.yaml`
  (NOT `onlyBuiltDependencies`) — `esbuild: true` is the default. Add allowances
  (or any pnpm setting) via `pnpmWorkspace(workspace)`, not by editing the YAML.
- **The engine is dogfooded as a normal auto-discovered package**, not a hand-
  authored special case: it lives at `workspaces/cli/dbx-tools` (tag `cli`,
  name `dbx-tools`), which auto-discovery would otherwise render as
  `@dbx-tools/cli-dbx-tools`. `.projenrc.ts`'s `workspacePackage(pkg, spec)` hook
  special-cases `spec.tags.includes("cli") && spec.name === "dbx-tools"` to:
  override the name to `@dbx-tools/cli` (`pkg.package.addField("name", ...)`),
  add its bin (`pkg.package.addBin({ dbxtools: "./bin/dbxtools.ts" })`), add its
  own deps (`projen`, `constructs`, `barrelsby`, `chokidar`, `consola`,
  `openapi-typescript`, `tsoa`, `yaml`, `tsx`, `pnpm` - `commander` already comes
  from the `cli` tag), and bump its tsconfig to ES2022 lib/target + `rootDir: "."`
  + extra includes for `index.ts`/`bin/**/*.ts` (the `cli` tag's defaults are
  ES2020 + `src/**/*.ts` only, which doesn't cover `Object.hasOwn` in `log.ts`
  or anything outside `src/`).
- **`configureProject` keeps the engine itself resolvable across synths** via
  `engineSelfDependency()` (`configure.ts`): reads the engine's OWN nearby
  `package.json` (two directories up from `configure.ts`) for its name; if that
  path passes through a `node_modules` segment (an installed/external
  consumer), it adds that name as a root devDep - reusing WHATEVER specifier is
  already in the consumer's current `package.json` for it (`file:`, `link:`, a
  version, anything) rather than computing one, since overwriting a `file:`/
  `link:` install with a version range would silently repoint it at the
  registry. If the path does NOT pass through `node_modules` (this repo's own
  dogfooding - relative-imported, no package resolution involved), it returns
  `undefined` and adds nothing.
- **The caller must set `packageManager: PNPM`** (via `extends`, or let the
  engine default to it) — projen's `packageManager` is readonly after
  construction, so this can't be changed post-hoc.
- **`typecheck.ts` resolves `typescript/bin/tsc` lazily** (memoized function,
  not a module-level const) - like `barrels.ts` already does for barrelsby.
  Resolving it eagerly broke merely *importing* `configureProject` (which pulls
  in `typecheck.ts` via the barrel) whenever a consumer's `typescript` install
  happened to be an unusual version with a narrower `exports` map.
- Repo is `type: module`. Packages get a `module: ESNext` + `moduleResolution:
  bundler` overlay (`SHARED_COMPILER_OPTIONS` in `packages.ts`) because projen's
  default `module: CommonJS` breaks the ESM sources' `import.meta`; `bundler`
  honors the `exports` map, so a bare `@dbx-tools/<pkg>` import resolves to that
  package's ROOT `index.ts` barrel — packages type-check against each other with
  no build step. Cross-package imports still need the workspace dep declared
  (`pkg.addDeps("@dbx-tools/shared-core@workspace:*")` in `workspacePackage()`).
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
  openapi` / a watched controller edit needs them). `sync --watch` regenerates
  it automatically when a controller changes.
