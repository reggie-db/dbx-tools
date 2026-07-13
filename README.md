# dbx-tools

A [projen](https://projen.io)-driven **pnpm monorepo generator**. The reusable
engine is its own package, **`@dbx-tools/cli`**, exported as `configureProject()`
and driven by the **`dbxtools`** CLI. Drop a folder under `workspaces/` and it's
configured, type-checked, and barrelled automatically - or bootstrap a brand-new
empty folder from nothing with `dbxtools sync`.

> New contributor or agent? Read **[AGENTS.md](./AGENTS.md)** for the full model.

```ts
// .projenrc.ts (a normal consumer)
import { configureProject } from "@dbx-tools/cli";

// Constructs the NodeProject, auto-discovers packages, and synthesizes (synth
// defaults to true). Pass your own project as the first arg to tap into it;
// omit it and one is created from the engine's defaults + `extends`.
configureProject(undefined, {
  // The one place per-package tweaks live: mutate the real projen subproject
  // `pkg`, dispatching on the stable folder identity spec.tags / spec.name.
  workspacePackage: (pkg, spec) => {
    /* e.g. pkg.addDeps("@dbx-tools/shared-core@workspace:*") */
  },
});
```

## Bootstrap an empty folder

```sh
mkdir my-workspace && cd my-workspace
pnpm dlx dbxtools sync   # (once published) - or run the bin directly if installed locally
```

On a folder with no `package.json`, `sync` runs `pnpm init`, installs `projen`
+ `typescript` + `tsx` + itself, writes a minimal `.projenrc.ts`, and synthesizes
- no example folders or sample code, just enough for `pnpm exec projen` (or
`dbxtools sync`) to work from there on. Drop a `workspaces/<tag>/<name>/src`
folder afterward and it's picked up on the next sync.

## Tags enforce a runtime (auto-applied by folder)

A workspace package is any `src`-bearing folder under a **`workspacePackageRoots`**
root (default `["workspaces"]`; this repo also adds `example-workspaces/` for its
seed content). The folder's path relative to the root becomes its **tags** (Bit
style - a tag names a target environment, not an npm scope): `ui/app` → tags
`[ui, ui-app]` via cumulative dash-join, matched against `workspacePackageTagPaths`
(default: identity over the tag names). Each matched tag maps to a config in
`WORKSPACE_TAGS` (`.../src/projen/tags.ts`) that drives the generated `tsconfig`
(`lib`/`jsx`/`types`) + baseline deps - so misuse fails `tsc`:

| Tag      | Runtime                    | DOM | Node |
| -------- | -------------------------- | --- | ---- |
| `ui`     | Vite + React (+vite.config)|  ✓  |  ✗   |
| `server` | Node (Express, tsoa, …)    |  ✗  |  ✓   |
| `node`   | Node                       |  ✗  |  ✓   |
| `cli`    | Node + commander + @clack  |  ✗  |  ✓   |
| `shared` | agnostic                   |  ✗  |  ✗   |
| `openapi`| generated read-only client |  ✓  |  ✗   |

Packages are named `@<scope>/<path-dash-joined>` (here `@dbx-tools/*`, the scope
being the resolved project name), and each records its resolved tags in its
`package.json` under `dbxToolsConfig.tags`. The member set is written to
**`pnpm-workspace.yaml`** (the source of truth), sourced from projen's own
`project.subprojects`.

## Config hooks

- **`workspacePackage(pkg, spec)`** - per-package tweaks; runs LAST (after the
  built-in default tag modifiers) in a deferred pass once every package is
  configured.
- **`workspacePackageDefaults`** (`"all"` | list) - which built-in default tag
  modifiers run (e.g. the `server` default adds Express + `dev`/`start` tasks).
- **`workspacePackageTagPaths`** - map a path/pattern to extra tag(s).
- **`onGeneratedFile(file, project)`** - inspect/tweak every generated projen file.
- **`pnpmWorkspace(cfg)`** - tweak the assembled `pnpm-workspace.yaml`.

## The `dbxtools` CLI

```sh
pnpm install
pnpm dbxtools sync             # bootstrap an empty folder, or synth an existing workspace
pnpm dbxtools sync --watch     # watch: re-synth on config/package changes, barrels on edits
pnpm dbxtools barrels          # rebuild every package's root index.ts barrel
pnpm dbxtools typecheck        # type-check each package against its tag tsconfig
pnpm dbxtools openapi          # generate the openapi packages from tsoa controllers
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
client - colocated under the controller package's own root. It regenerates
automatically under `sync --watch` whenever a controller changes.

## Barrels & generated files

Each package gets a root `index.ts` (via [barrelsby](https://github.com/bencoveney/barrelsby))
re-exporting `./src/*`, skipping files/folders starting with `_` and files with
no `export`. Barrels regenerate on every re-synth. Barrels and all projen-owned
files (`package.json`, `tsconfig*`, `pnpm-workspace.yaml`, …) are **read-only
with a do-not-edit / projen marker** - edit `.projenrc.ts` (or a hook) and
re-synth; never edit them directly.

## Status

Green: synth, `pnpm install`, `dbxtools barrels`/`typecheck`/`openapi`,
`dbxtools sync --watch`, and bootstrapping a completely empty folder all work
end to end. This work lives on the `main` branch of `reggie-db/dbx-tools`.
