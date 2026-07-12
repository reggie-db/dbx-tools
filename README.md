# projen-workspace

A [projen](https://projen.io)-driven **pnpm monorepo** where the folder a package
lives in enforces which runtime it may touch, barrels are regenerated for you,
and dropping a `src/` folder is enough to scaffold a fully-configured package.

All the machinery lives in one reusable package — **`@dbx-tools/projen-config`**
(`packages/dbx-tools/projen-config`) — exported as `configureProjen()` and driven
by a single `dbxtools` CLI, so the same setup can be published to npm and reused
from any other repo's `projenrc.ts`:

```ts
// projenrc.ts — the whole repo config (no leading dot; projen finds it natively)
import { configureProjen } from "./packages/dbx-tools/projen-config/src/configure";
import type { PackageSpec } from "./packages/dbx-tools/projen-config/src/packages";

const PACKAGES: PackageSpec[] = [ /* this repo's packages */ ];

configureProjen({ name: "projen-workspace", packages: PACKAGES }).synth();
```

## Scopes enforce a runtime

The folder directly under `packages/` maps to one of six enforcement **profiles**.
The profile is the single source of truth for a package's generated
`tsconfig.json` (`lib`/`jsx`/`types`) and baseline deps, so enforcement is real:

| Scope folder | Profile    | DOM | Node | Injected deps                    |
| ------------ | ---------- | --- | ---- | -------------------------------- |
| `shared/*`   | `agnostic` |  ✗  |  ✗   | —                                |
| `server/*`   | `node`     |  ✗  |  ✓   | `@types/node`                    |
| `cli/*`      | `cli`      |  ✗  |  ✓   | `commander`, `@clack/prompts`    |
| `dom/*`      | `dom`      |  ✓  |  ✗   | —                                |
| `ui/*`       | `react`    |  ✓  |  ✗   | `react` (peer) + types           |
| `client/*`   | `vite`     |  ✓  |  ✗   | `react`, `vite`, + `vite.config` |
| `dbx-tools/*`| `node`     |  ✗  |  ✓   | (the engine)                     |

`tsc` proves it: `document` in a `shared`/`server`/`cli` package fails (no DOM
`lib`), and `process`/`node:*` in a `ui`/`client` package fails (no `node` types).
Add or remap a scope with one line in the engine's `SCOPES`.

## Packages

`packages/<scope>/<name>` → published `@<scope>/<name>`; multiple packages can
share a scope. Each package gets a projen-generated `package.json` + `tsconfig.json`
(and `vite.config.ts` in the `vite` scope). The `vite` profile writes the vite
config automatically — you never hand-author one.

## The `dbxtools` CLI + projen tasks

Everything runs through `dbxtools` (commander, a single entry point). The projen
tasks are thin subcommands — run `pnpm exec projen <task>`:

| Task        | `dbxtools` cmd | What it does                                           |
| ----------- | -------------- | ------------------------------------------------------ |
| `projen`    | —              | Synthesize all generated config (default) + install.   |
| `watch`     | `watch`        | Watch `packages/*`: barrels + scaffolding on change.   |
| `barrels`   | `barrels`      | Rebuild every package's root `index.ts` barrel.        |
| `scaffold`  | `scaffold`     | Configure any new `packages/<scope>/<name>/src`.       |
| `typecheck` | `typecheck`    | Type-check each package against its own profile.       |

## Barrels (index above src)

`watch`/`barrels` drive **barrelsby** to write one `index.ts` **at each package
root** (above `src/`) that flat-re-exports `./src/*`, subject to two rules:

1. a file/folder whose name starts with `_` is private and never barrelled;
2. only files that actually contain an `export` are re-exported.

Each barrel gets a `// GENERATED … DO NOT EDIT` header and is set **read-only**;
the watcher unlocks → regenerates → re-locks on every change.

## Auto-scaffold

Create `packages/<scope>/<name>/src/anything.ts` and run `projen scaffold` (or
just have `projen watch` running). The engine discovers the folder, generates its
`package.json` + `tsconfig.json` from the scope's profile, and gives it a
generated name **`@<rootScope>/<scope>-<name>`** (e.g. `@projen-workspace/ui-widgets`).
`rootScope` is the `scope` option, defaulting to the project name; pass `scope: ""`
to leave scaffolded packages unscoped. Declare the package explicitly in
`projenrc.ts` to override the name/deps.

## Hooks

- `configureProjen({ packageModifier })` — a `(manifest, ctx) => manifest`
  last-chance hook to change any generated `package.json` before it's written.
- `generateBarrels({ modifier })` — a `(content, ctx) => content` hook for the
  barrel contents.

## Logging

The dev logger is a single [consola](https://github.com/unjs/consola) instance
(`src/log.ts`) that routes **all** output to **stderr** (stdout stays clean for
piping). Each task tags its output with `logger.withTag("projen:watch")` etc.

## Generated files

- **projen-owned** (`package.json`, `tsconfig*.json`, `pnpm-workspace.yaml`,
  `.vscode/*`, `projenrc/discovered.json`) — read-only, projen marker.
- **barrels** (`<pkg>/index.ts`) — read-only, do-not-edit header.

Edit `projenrc.ts` (source of truth) and re-synth; never edit generated files.

## VS Code

`.vscode/tasks.json` (a projen `JsonFile`) has `runOn: folderOpen`, so opening the
workspace auto-starts `projen watch`. No custom extension.

## Portability

The engine is pure Node: `node:fs` for walking, `fs.chmodSync` for read-only, and
the three tools it invokes (barrelsby, tsc, the projenrc re-synth) run via
`execFileSync(process.execPath, [require.resolve(...)…])` — Node executing a
resolved `.js`, no shell and no platform-specific bin paths. Relative imports
(`./log`, `../src/watch`) resolve within the package whether it's in-repo or
installed from npm.

## Getting started

```sh
pnpm install
pnpm exec projen           # synthesize config
pnpm exec projen barrels
pnpm exec projen typecheck
```
