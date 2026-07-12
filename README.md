# dbx-tools

A [projen](https://projen.io)-driven **pnpm monorepo generator**. The reusable
engine is its own package, **`@dbx-tools/cli`**, exported as `configureProjen()`
and driven by the **`dbxtools`** CLI. Drop a folder under `workspaces/` and it's
configured, type-checked, and barrelled automatically - or bootstrap a brand-new
empty folder from nothing with `dbxtools sync`.

> New contributor or agent? Read **[AGENTS.md](./AGENTS.md)** for the full model.

```ts
// .projenrc.ts
import { configureProjen } from "@dbx-tools/cli";

// configureProjen constructs the NodeProject itself, merging its own sensible
// defaults (pnpm, no jest/eslint/prettier/release/...) with anything you set in
// `extends`. The one place per-package tweaks live: mutate the real projen
// subproject `pkg`, dispatching on the stable folder identity spec.env/spec.name.
const project = configureProjen({
  workspace: (pkg, spec) => {
    /* e.g. pkg.addDeps("@dbx-tools/shared-core@workspace:*") */
  },
});

project.synth();
```

## Bootstrap an empty folder

```sh
mkdir my-workspace && cd my-workspace
pnpm dlx dbxtools sync   # (once published) - or run the bin directly if installed locally
```

On a folder with no `package.json`, `sync` runs `pnpm init`, installs `projen`
+ `typescript` + `tsx` + itself, writes a minimal `.projenrc.ts`, and synthesizes
- no example env folders or sample code, just enough for `pnpm exec projen` (or
`dbxtools sync`) to work from there on. Drop a `workspaces/<env>/<name>/src`
folder afterward and it's picked up on the next sync.

## Envs enforce a runtime (auto-applied by folder)

A folder under a workspace-env root (default `workspaces/`; this repo also adds
`example-workspaces/` for its own seed content) is an **env** (Bit-style — the
target environment, not an npm scope). Each env maps to one config
(`WORKSPACE_ENVS` in `.../src/projen/envs.ts`) that drives the generated
`tsconfig` (`lib`/`jsx`/`types`) + baseline deps — so misuse fails `tsc`:

| Env      | Runtime                    | DOM | Node |
| -------- | -------------------------- | --- | ---- |
| `ui`     | Vite + React (+vite.config)|  ✓  |  ✗   |
| `server` | Node (Express, tsoa, …)    |  ✗  |  ✓   |
| `node`   | Node                       |  ✗  |  ✓   |
| `cli`    | Node + commander + @clack  |  ✗  |  ✓   |
| `shared` | agnostic                   |  ✗  |  ✗   |
| `openapi`| generated read-only client |  ✓  |  ✗   |

Packages live at `<envRoot>/<env>/<name>` and are named `@<scope>/<env>-<name>`
(here `@dbx-tools/*`, the `@scope/` being the resolved project name). The
discovered set is written to **`pnpm-workspace.yaml`** — the source of truth every
command reads back, sourced straight from projen's own `project.subprojects`.

## The `dbxtools` CLI

```sh
pnpm install
pnpm dbxtools sync             # bootstrap an empty folder, or synth an existing workspace
pnpm dbxtools sync --watch     # watch: re-synth on config/package changes, barrels on edits
pnpm dbxtools barrels          # rebuild every package's root index.ts barrel
pnpm dbxtools typecheck        # type-check each package against its env tsconfig
pnpm dbxtools openapi          # generate the openapi env from tsoa controllers
pnpm exec projen watch         # projen's watch task -> `pnpm dbxtools sync --watch`
```

## OpenAPI, without JSDoc

Annotate a controller with [tsoa](https://tsoa-community.github.io/docs/)
decorators in a `server`/`node` package - no JSDoc, no YAML:

```ts
@Route("greeting")
export class GreetingController extends Controller {
  @Get("{name}")
  public async getGreeting(@Path() name: string): Promise<Greeting> {
    return { message: `Hello, ${name}!` };
  }
}
```

`dbxtools openapi` infers the OpenAPI 3 spec from the decorators + TS types and
generates a read-only, typed [openapi-fetch](https://openapi-ts.dev/openapi-fetch/)
client - colocated next to the controller's own env root. It regenerates
automatically under `sync --watch` whenever a controller changes.

## Barrels & generated files

Each package gets a root `index.ts` (via [barrelsby](https://github.com/bencoveney/barrelsby))
re-exporting `./src/*`, skipping files/folders starting with `_` and files with
no `export`. Barrels regenerate on every re-synth. Barrels and all projen-owned
files (`package.json`, `tsconfig*`, `pnpm-workspace.yaml`, …) are **read-only
with a do-not-edit / projen marker** — edit `.projenrc.ts` (or a `workspace()`
hook) and re-synth; never edit them directly.

## Status

Green: synth, `pnpm install`, `dbxtools barrels`/`typecheck`/`openapi`,
`dbxtools sync --watch`, and bootstrapping a completely empty folder all work
end to end. This work lives on the `main` branch of `reggie-db/dbx-tools`.
