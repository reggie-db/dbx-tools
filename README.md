# dbx-tools

A [projen](https://projen.io)-driven **pnpm monorepo generator**. The reusable
engine is its own package, **`@dbx-tools/cli`** (at `dbx-tools/`), exported as
`configureProjen()` and driven by the **`dbxtools`** CLI. Drop a folder under
`workspaces/` and it's configured, type-checked, and barrelled automatically.

> New contributor or agent? Read **[AGENTS.md](./AGENTS.md)** for the full model.

```ts
// .projenrc.ts
import { javascript } from "projen";
import { configureProjen } from "./dbx-tools/src/projen/configure";

// name "" is backfilled from the repo identity (-> `dbx-tools`, scope `@dbx-tools/*`).
const project = new javascript.NodeProject({
  name: "",
  packageManager: javascript.NodePackageManager.PNPM,
});
configureProjen(project, {
  // workspaceEnvPaths defaults to ["workspaces"]; add extra members with additionalWorkspaces.
  // The one place per-package tweaks live: mutate the real projen subproject `pkg`,
  // dispatching on the stable folder identity spec.env / spec.name.
  modifyPackage: (pkg, spec) => {
    /* e.g. pkg.addDeps("@dbx-tools/shared-core@workspace:*") */
  },
});
project.synth();
```

## Envs enforce a runtime (auto-applied by folder)

A folder under a workspace-env root (default `workspaces/`) is an **env**
(Bit-style — the target environment, not an npm scope). Each env maps to one
config (`WORKSPACE_ENVS` in `dbx-tools/src/projen/envs.ts`) that drives the
generated `tsconfig` (`lib`/`jsx`/`types`) + baseline deps — so misuse fails `tsc`:

| Env      | Runtime                    | DOM | Node |
| -------- | -------------------------- | --- | ---- |
| `ui`     | Vite + React (+vite.config)|  ✓  |  ✗   |
| `server` | Node (Express, …)          |  ✗  |  ✓   |
| `node`   | Node                       |  ✗  |  ✓   |
| `cli`    | Node + commander + @clack  |  ✗  |  ✓   |
| `shared` | agnostic                   |  ✗  |  ✗   |
| `openapi`| generated read-only client |  ✓  |  ✗   |

Packages live at `workspaces/<env>/<name>` and are named `@<scope>/<env>-<name>`
(here `@dbx-tools/*`, the `@scope/` being the resolved project name). The
discovered set is written to **`pnpm-workspace.yaml`** — the source of truth every
command reads back.

## The `dbxtools` CLI

```sh
pnpm install
pnpm dbxtools sync            # run projen (synth) — regenerates config + barrels
pnpm dbxtools sync --watch    # watch: re-synth on config/package changes, barrels on edits
pnpm dbxtools barrels         # rebuild every package's root index.ts barrel
pnpm dbxtools typecheck       # type-check each package against its env tsconfig
pnpm exec projen watch        # projen's watch task -> `pnpm dbxtools sync --watch`
```

## Barrels & generated files

Each package gets a root `index.ts` (via barrelsby) re-exporting `./src/*`,
skipping files/folders starting with `_` and files with no `export`. Barrels
regenerate on every re-synth. Barrels and all projen-owned files (`package.json`,
`tsconfig*`, `pnpm-workspace.yaml`, …) are **read-only with a do-not-edit / projen
marker** — edit `.projenrc.ts` (or a `modifyPackage` hook) and re-synth; never
edit them directly.

## Status

Green: synth, `pnpm install`, `dbxtools barrels`, `dbxtools typecheck`, and
`dbxtools sync --watch` all work. OpenAPI generation is deferred (moving from
JSDoc to zod). This work lives on the `main` branch of `reggie-db/dbx-tools`.
