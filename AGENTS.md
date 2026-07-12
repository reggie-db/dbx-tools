# AGENTS.md

Orientation for AI agents / new contributors. Read this first.

## What this repo is

A **projen-driven pnpm monorepo generator**. The reusable engine is its own
package, **`dbx-tools`**, living at **`tooling/dbx-tools`** (it is *not* under
`packages/` and is *not* auto-configured, so repos that consume it from npm
don't inherit it). It exports **`configureProjen(project, options)`** and ships
the **`dbxtools`** CLI. `packages/*` are example workspaces that exercise it.

> Local dir is `projen-workspace/`; the GitHub repo is `reggie-db/dbx-tools`
> (this work is on branch **`main`**; `master` holds older work and is still the
> default). WIP. OpenAPI→zod is deferred (see below).

## Mental model

- **Scopes are folders.** Any `packages/<scope>/<name>/src` is configured
  automatically from its scope — no declaration needed. Scopes live in ONE map
  (`tooling/dbx-tools/src/scopes.ts`, `SCOPES` / `ScopeDef` — there is no
  separate "profile" type):
  - `ui` → Vite/React (DOM + `vite/client` types, jsx, `vite.config.ts`)
  - `server` / `node` → Node (`@types/node`, no DOM)
  - `cli` → Node + `commander` + `@clack/prompts`
  - `shared` → agnostic (no DOM, no Node)
  - `openapi` → generated, read-only clients
  Enforcement is real via each package's generated `tsconfig` `lib`/`types`:
  `document` in `shared`/`server` fails `tsc`; `process`/`node:*` in `ui` fails.
- **Names**: `@<rootScope>/<scope>-<name>`, collapsing to `@<rootScope>/<name>`
  when the folder scope equals the root scope. `rootScope` = the `scope` option,
  else the project name (auto-detected: `npm prefix` → git remote → dir).
  Here `scope: "dbx-tools"` → e.g. `@dbx-tools/shared-core`, `@dbx-tools/ui-app`.
- **No per-package config in `.projenrc.ts`.** Everything is auto-detected; the
  only place per-package tweaks belong is the **`modifyPackage(scope, manifest)`**
  and **`modifyTsconfig(scope, tsconfig)`** hooks (manifests are plain records).

## Layout

```
.projenrc.ts                 # creates NodeProject, calls configureProjen(project, {...})
tooling/dbx-tools/           # the engine (package "dbx-tools"), hand-authored
  bin/dbxtools.ts            # the CLI (commander): sync|barrels|scaffold|typecheck|openapi
  index.ts                   # public API barrel (hand-written; it's the bootstrap pkg)
  src/
    configure.ts             # configureProjen(project, options)
    scopes.ts                # SCOPES map + ScopeDef (the one scope type)
    packages.ts              # definePackage + modifyPackage/modifyTsconfig hooks
    barrels.ts               # barrelsby driver (root index.ts, header + read-only)
    scaffold.ts              # packageSetChanged() + runSynth()
    openapi.ts               # openapi scope generator (deferred: still swagger-jsdoc)
    typecheck.ts, workspace.ts, generated.ts, log.ts, discovered.ts
packages/<scope>/<name>/     # example packages (source only; configs are generated)
```

## Generated files — DO NOT edit by hand

- projen-owned (`package.json`, `tsconfig*.json`, `pnpm-workspace.yaml`,
  `.vscode/*`, `projenrc/discovered.json`, `vite.config.ts`): read-only, projen
  marker. Change `.projenrc.ts` (or a hook) and re-synth.
- barrels (`packages/<scope>/<name>/index.ts`): read-only, do-not-edit header,
  written by barrelsby. Marked generated in `.gitattributes` (`annotateGenerated`).

## Commands

```sh
pnpm install                 # link workspace + engine
pnpm exec projen             # synthesize all generated config (+ install)
pnpm exec dbxtools barrels   # rebuild every package's root index.ts
pnpm exec dbxtools typecheck # tsc --noEmit per package (proves scope enforcement)
pnpm exec dbxtools sync      # re-synth if package set changed, then barrels
pnpm exec projen watch       # onchange -> `dbxtools sync` (the projen watch task)
```

Barrels re-export every exporting file under `src/` except names starting with
`_`; a package's barrel lives at its ROOT (`index.ts`), re-exporting `./src/*`.

## Gotchas

- **pnpm v11** gates build scripts behind `allowBuilds` in `pnpm-workspace.yaml`
  (NOT `onlyBuiltDependencies`) — `esbuild: true` is set there.
- The engine (`tooling/dbx-tools`) is **hand-authored** (its own `package.json`/
  `tsconfig.json`/`index.ts`) because it bootstraps everything else; it is not
  generated and not auto-discovered. Type-check it with
  `tsc --noEmit -p tooling/dbx-tools/tsconfig.json`.
- Repo is `type: module`; projenrc uses `import.meta.dirname`, not `__dirname`.
- Everything runs on portable Node: subprocesses use `execFileSync(process.execPath, …)`;
  read-only is `fs.chmodSync` (Node maps it to the Windows read-only attribute).
- **Deferred:** OpenAPI generation should move from swagger-jsdoc (`@openapi`
  JSDoc) to **zod** (`zod-openapi`, no JSDoc), scanning `server`/`node` scopes.
