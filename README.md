# dbx-tools

A [projen](https://projen.io)-driven **pnpm monorepo generator**. The reusable
engine is its own package — **`dbx-tools`** (`tooling/dbx-tools`) — exported as
`configureProjen()` and driven by the **`dbxtools`** CLI. Drop a folder under
`packages/` and it's configured, type-checked, and barrelled automatically.

> New contributor or agent? Read **[AGENTS.md](./AGENTS.md)** for the full model.

```ts
// .projenrc.ts
import { javascript } from "projen";
import { configureProjen } from "./tooling/dbx-tools/src/configure";

const project = new javascript.NodeProject({ name: "dbx-tools-workspace", /* … */ });
configureProjen(project, {
  scope: "dbx-tools",
  modifyPackage: (scope, manifest) => manifest, // the one place per-package tweaks go
});
project.synth();
```

## Scopes enforce a runtime (auto-applied by folder)

The folder under `packages/` is the scope; each maps to one config (`SCOPES` in
`tooling/dbx-tools/src/scopes.ts`) that drives the generated `tsconfig`
(`lib`/`jsx`/`types`) + baseline deps — so misuse fails `tsc`:

| Scope    | Runtime                    | DOM | Node |
| -------- | -------------------------- | --- | ---- |
| `ui`     | Vite + React (+vite.config)|  ✓  |  ✗   |
| `server` | Node (Express, …)          |  ✗  |  ✓   |
| `node`   | Node                       |  ✗  |  ✓   |
| `cli`    | Node + commander + @clack  |  ✗  |  ✓   |
| `shared` | agnostic                   |  ✗  |  ✗   |
| `openapi`| generated read-only client |  ✓  |  ✗   |

Packages are named `@<scope>/<folder>-<name>` (here `@dbx-tools/*`).

## The `dbxtools` CLI

```sh
pnpm install
pnpm exec projen              # synthesize all generated config
pnpm exec dbxtools barrels    # rebuild every package's root index.ts barrel
pnpm exec dbxtools typecheck  # type-check each package against its scope tsconfig
pnpm exec projen watch        # onchange -> `dbxtools sync` (barrels + re-synth on change)
```

## Barrels & generated files

Each package gets a root `index.ts` (via barrelsby) re-exporting `./src/*`,
skipping files/folders starting with `_` and files with no `export`. Barrels and
all projen-owned files (`package.json`, `tsconfig*`, `pnpm-workspace.yaml`, …)
are **read-only with a do-not-edit / projen marker** — edit `.projenrc.ts` (or a
`modifyPackage`/`modifyTsconfig` hook) and re-synth; never edit them directly.

## Status

WIP. OpenAPI generation is being moved from JSDoc to zod (`zod-openapi`). This
repo lives on the `main` branch of `reggie-db/dbx-tools`.
