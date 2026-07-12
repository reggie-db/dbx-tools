# AGENTS.md

Orientation for AI agents / new contributors. Read this first.

## What this repo is

A **projen-driven pnpm monorepo generator**. The reusable engine is its own
package, **`@dbx-tools/cli`**, living at **`dbx-tools/`** (it is *not* under a
workspace-env root and is *not* auto-configured, so repos that consume it from
npm don't inherit it). It exports **`configureProjen(project, options)`** and
ships the **`dbxtools`** CLI. `workspaces/*` are example packages that exercise it.

> Local dir is `projen-workspace/`; the GitHub repo is `reggie-db/dbx-tools`
> (this work is on branch **`main`**; `master` holds older work and is still the
> default).

## Vocabulary (important)

- **env** — a folder directly under a *workspace-env root* (e.g. `workspaces/ui`
  → env `ui`). Bit-style, it names the target *environment* (React/Vite, Node,
  agnostic, …). Envs are NOT npm scopes.
- **scope** — reserved for the npm `@scope/` in package identifiers (e.g. the
  `@dbx-tools` in `@dbx-tools/ui-app`). Don't call env folders "scopes".
- **workspace package** — `workspaces/<env>/<name>` (a `<env>/<name>` folder with
  a `src/` holding a module file).

## Mental model

- **`pnpm-workspace.yaml` is the source of truth.** `configureProjen` scans the
  filesystem ONCE at synth (under each `workspaceEnvPaths` root) and writes the
  discovered member list to `pnpm-workspace.yaml`. Every other command
  (`barrels`, `typecheck`, the watcher) reads it back via `discoverPackages()`
  (no args) — see `workspace.ts` — rather than re-scanning the tree. Passing
  `discoverPackages(root, paths)` is the filesystem scan; passing nothing reads
  the recorded truth.
- **Discovery.** For each `workspaceEnvPaths` root (default `["workspaces"]`),
  the immediate subfolders are env names; each `<env>/<name>` folder whose `src/`
  contains a `.ts`/`.tsx`/`.js`/`.jsx` module file becomes a package. No
  declaration needed — drop a `src/` folder and it's picked up on the next synth.
- **Every package is a real projen subproject.** `definePackage` (`packages.ts`)
  creates a `typescript.TypeScriptProject` with `parent: root`. projen then OWNS
  that package's `package.json`, `tsconfig.json`, tasks, `README.md`, `.projen/`.
  Baseline projen features are off to match the root (`jest`/`eslint`/`prettier`/
  `github`/`release`/`depsUpgrade: false`, `sampleCode: false`).
- **Envs are ONE map.** `envs.ts` — `WORKSPACE_ENVS` / `WorkspaceEnvDef` (no
  separate "profile" type). A `WorkspaceEnvDef` IS a projen `TypeScriptProject`
  options bag (`Partial<TypeScriptProjectOptions>`) plus two engine-only extras
  (`tasks`, `viteConfig`); `definePackage` spreads it into the subproject. So an
  env sets projen-native `deps`/`devDeps`/`peerDeps` + `tsconfig.compilerOptions`
  (projen enums, e.g. `TypeScriptJsxMode.REACT_JSX`), merged over projen defaults
  so env `lib`/`jsx`/`types`/`target` win:
  - `ui` → Vite/React (DOM + `vite/client` types, jsx, `vite.config.ts`)
  - `server` / `node` → Node (`@types/node`, no DOM)
  - `cli` → Node + `commander` + `@clack/prompts`
  - `shared` → agnostic (no DOM, no Node)
  - `openapi` → generated, read-only clients (from tsoa controllers)
  Enforcement is real via each package's generated `tsconfig` `lib`/`types`:
  `document` in `shared`/`server` fails `tsc`; `process`/`node:*` in `ui` fails.
- **Names**: `npmNameOf(scope, "<env>/<name>")` (`packages.ts`) → normalized,
  lowercased, joined as `@<scope>/<env>-<name>` (e.g. `@dbx-tools/shared-core`).
  The npm scope is the resolved project name: the project may be created with
  `name: ""`, and `configureProjen` backfills it from the auto-detected repo
  identity (git remote → folder) and threads it into `definePackage` as
  `npmScope` (the readonly `project.name` can't be read back). So this repo's
  empty-named project in `reggie-db/dbx-tools` resolves to `dbx-tools`, giving
  `@dbx-tools/*` packages. The engine is `@dbx-tools/cli` (scoped) so it doesn't
  collide with the `dbx-tools` root project name.
- **No per-package config in `.projenrc.ts`.** Everything is auto-detected; the
  only place per-package tweaks belong is **`modifyPackage(pkg, spec)`**. `pkg` is
  the REAL subproject and the only thing you mutate — use projen's API
  (`pkg.addDeps("x@catalog:")`, `pkg.addTask(...)`, `pkg.package.addBin({...})`).
  `spec` is read-only identity; dispatch on the stable folder
  (`spec.env` + `spec.name`, e.g. `"cli"`/`"main"`), not the derived `packageName`.
- **Workspace membership is discovered, not hardcoded.** `pnpm-workspace.yaml`
  `packages:` = the discovered env packages plus any **`additionalWorkspaces`**
  members OUTSIDE the env layout — this repo passes
  `additionalWorkspaces: ["dbx-tools"]` to include the in-tree engine (a repo
  consuming `@dbx-tools/cli` from npm omits it). The whole file is a typed
  **`PnpmWorkspaceConfig`** (`packages`/`catalog`/`allowBuilds` + any extra pnpm
  key), tweakable last via **`modifyPnpmWorkspace(workspace)`**.

## Layout

```
.projenrc.ts                 # creates NodeProject, calls configureProjen(project, {...})
dbx-tools/                   # the engine (package "@dbx-tools/cli"), hand-authored
  bin/dbxtools.ts            # the CLI (commander): sync [--watch] | barrels | typecheck | openapi
  index.ts                   # public API barrel (hand-written; it's the bootstrap pkg)
  src/
    log.ts                   # projen-AGNOSTIC utilities live at src/ root
    projen/                  # everything projen-specific lives under src/projen/
      configure.ts           # configureProjen(project, options) + post-synth barrels component
      envs.ts                # WORKSPACE_ENVS map + WorkspaceEnvDef (the one env type)
      workspace.ts           # discovery: DiscoveredPackage + discoverPackages (fs | pnpm-yaml)
      packages.ts            # definePackage -> TypeScriptProject subproject + modifyPackage hook
      barrels.ts             # barrelsby driver (root index.ts, header + read-only)
      watch.ts               # chokidar orchestration for `sync --watch`
      scaffold.ts            # packageSetChanged() + runSynth({ post })
      openapi.ts             # openapi env generator (tsoa controllers -> spec + client)
      typecheck.ts, generated.ts, files.ts
workspaces/<env>/<name>/     # example packages; each is a projen TypeScriptProject subproject
```

The engine's `src/` is split by concern: projen-agnostic utilities (e.g. `log.ts`)
stay at `src/` root; everything projen-specific lives under `src/projen/`.

## Commands (the `dbxtools` CLI)

```sh
pnpm install                 # link workspace + engine
pnpm exec projen             # synth all generated config (+ install + barrels)
pnpm dbxtools sync           # one-shot: run projen (synth), which regenerates barrels
pnpm dbxtools sync --watch   # watch: re-synth on config/package changes, barrels on edits
pnpm dbxtools barrels        # rebuild every package's root index.ts barrel
pnpm dbxtools typecheck      # tsc --noEmit per package (proves env enforcement)
pnpm exec projen watch       # projen's watch task -> `pnpm dbxtools sync --watch`
```

- **`sync`** just runs projen (full synth, installs, regenerates barrels).
- **`sync --watch`** starts ONE chokidar process (see `watch.ts`) folding three
  concerns: config edit (`.projenrc.ts` / in-tree engine `src`) → re-synth;
  package SET change (new/removed `src` folder) → re-synth (+install); source
  edit in an existing package → rebuild just that package's barrel.
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
- **barrels** (`workspaces/<env>/<name>/index.ts`): read-only, do-not-edit header,
  written by barrelsby. Marked generated in `.gitattributes` (`annotateGenerated`).

Change an env, a hook, or `.projenrc.ts` and re-synth — never edit generated files.

## Gotchas

- **pnpm v11** gates build scripts behind `allowBuilds` in `pnpm-workspace.yaml`
  (NOT `onlyBuiltDependencies`) — `esbuild: true` is the default. Add allowances
  (or any pnpm setting) via `modifyPnpmWorkspace`, not by editing the YAML.
- The engine (`dbx-tools/`) is **hand-authored** (its own `package.json`/`index.ts`)
  because it bootstraps everything; it is not generated and not auto-discovered.
- **The caller must set `packageManager: PNPM`.** The engine emits
  `pnpm-workspace.yaml` + a `catalog:`, but projen's `packageManager` is readonly
  after construction, so `configureProjen` can't set it — the `NodeProject` in
  `.projenrc.ts` must.
- **The `dbxtools` CLI is invoked as `pnpm dbxtools <cmd>`.** `pnpm <name>` runs a
  matching package *script* if one exists, else the `<name>` *bin* — so a consumer
  (with `@dbx-tools/cli` from npm) hits the linked `dbxtools` bin, while THIS repo
  keeps the engine in-tree and *unlinked* and defines a `dbxtools` **script** in
  `.projenrc.ts` that runs the source through tsx (`receiveArgs: true` forwards
  the subcommand). The engine is deliberately **not** a `@dbx-tools/cli@workspace:*`
  root devDep — a `workspace:*` self-dep hard-fails `pnpm install`
  (`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`) during the bootstrap state the engine runs in.
- Repo is `type: module`. Packages get a `module: ESNext` + `moduleResolution:
  bundler` overlay (`SHARED_COMPILER_OPTIONS` in `packages.ts`) because projen's
  default `module: CommonJS` breaks the ESM sources' `import.meta`; `bundler`
  honors the `exports` map, so a bare `@dbx-tools/<pkg>` import resolves to that
  package's ROOT `index.ts` barrel — packages type-check against each other with
  no build step. Cross-package imports still need the workspace dep declared
  (`pkg.addDeps("@dbx-tools/shared-core@workspace:*")` in `modifyPackage`).
- Everything runs on portable Node: subprocesses use `execFileSync(process.execPath, …)`;
  read-only is `fs.chmodSync` (Node maps it to the Windows read-only attribute).
- **`package.json` is forced read-only** via `lockPackageJson` (`packages.ts`) on
  the root and every subproject, so the whole generated tree is consistent. projen
  still rewrites it each synth (clears the bit, writes, restores). Source/sample
  files the developer owns (`.projenrc.ts`, each package's `README.md`, `src/*`)
  stay writable.
- **OpenAPI** (`openapi.ts`, `dbxtools openapi`): scans `server`/`node` packages for
  **tsoa** controllers (classes with `@Route`/`@Get`/... - no JSDoc/YAML). For each,
  tsoa's `generateSpec` infers an OpenAPI 3 spec from the decorators + TS types, then
  openapi-typescript + openapi-fetch produce a read-only `<envRoot>/openapi/<name>`
  package (`openapi.json` + `src/schema.ts` + `src/client.ts`). The `server` env ships
  `tsoa` + `experimentalDecorators`. tsoa/typescript/openapi-typescript are lazy-loaded
  (only `dbxtools openapi` / a watched controller edit needs them). `sync --watch`
  regenerates it automatically when a controller changes.
