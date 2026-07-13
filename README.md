# dbx-tools

A [projen](https://projen.io)-driven **pnpm monorepo generator**. The reusable
engine is its own package, **`@dbx-tools/cli`**, exported as the
`DBXToolsNodeProject` / `DBXToolsTypeScriptProject` project subclasses and driven
by the **`dbxtools`** CLI. Drop a folder under `workspaces/` and it's configured,
type-checked, and barrelled automatically - or bootstrap a brand-new empty folder
from nothing with `dbxtools sync`.

> New contributor or agent? Read **[AGENTS.md](./AGENTS.md)** for the full model.

```ts
// .projenrc.ts (a normal consumer)
import { DBXToolsNodeProject, packageMixin } from "@dbx-tools/cli";

// Constructs the monorepo root and auto-discovers packages under workspaces/.
const project = new DBXToolsNodeProject();

// Per-package tweaks are mixins, applied across the construct subtree with the
// constructs-native project.with(...) (after the built-in DEFAULT_TAG_MIXINS the
// root applies during construction). Dispatch on a package's stable folder
// identity - its resolved tags (p.tags) + folder name.
project.with(
  packageMixin(
    (p) => p.tags.includes("ui") && p.name.endsWith("/app"),
    (p) => p.addDeps("@dbx-tools/shared-core@workspace:*"),
  ),
);
project.synth();
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

## Config: mixins + options

- **`project.with(...mixins)`** - per-package tweaks, applied across the construct
  subtree (constructs-native; runs after the built-in `DEFAULT_TAG_MIXINS` the root
  applies during construction). `tagMixin(tag, fn)` targets packages by tag;
  `packageMixin(predicate, fn)` by any predicate (dispatch on `p.tags` +
  `basename(p.outdir)`); `fileMixin(fn)` targets any generated file. Mutate via
  projen's API (`p.addDeps(...)`, `p.addTask(...)`, `p.package.addBin({...})`,
  `p.tsconfig?.file.addOverride(...)`).
- **`defaultTagMixins`** (`"all"` | list) - which built-in tag mixins run (e.g. the
  `server` mixin adds Express + `dev`/`start` tasks).
- **`workspacePackageTagPaths`** - map a path/pattern to extra tag(s).
- **`project.pnpmWorkspace`** - `.addCatalog(name, ver)` / `.allowBuild(name)` /
  `.addPackage(glob)` to tweak `pnpm-workspace.yaml` (or `file.addOverride(...)`).

## The `dbxtools` CLI

```sh
pnpm install
pnpm exec projen sync          # keep in sync while editing (projen --watch + dbxtools watch, concurrently)
pnpm dbxtools sync             # bootstrap an empty folder, or synth an existing workspace (one-shot)
pnpm dbxtools watch            # watch: re-synth on package add/remove, barrels on source edits
pnpm dbxtools barrels          # rebuild every package's root index.ts barrel
pnpm dbxtools typecheck        # type-check each package against its tag tsconfig
pnpm dbxtools openapi          # generate the openapi packages from tsoa controllers
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
automatically under `projen sync` (via `dbxtools watch`) whenever a controller changes.

## Barrels & generated files

Each package gets a root `index.ts` (via [barrelsby](https://github.com/bencoveney/barrelsby))
re-exporting `./src/*`, skipping files/folders starting with `_` and files with
no `export`. Barrels regenerate on every re-synth. Barrels and all projen-owned
files (`package.json`, `tsconfig*`, `pnpm-workspace.yaml`, …) are **read-only
with a do-not-edit / projen marker** - edit `.projenrc.ts` (or a hook) and
re-synth; never edit them directly.

## Status

Green: synth, `pnpm install`, `dbxtools barrels`/`typecheck`/`openapi`,
`projen sync` (concurrent `projen --watch` + `dbxtools watch`), and bootstrapping
a completely empty folder all work end to end. This work lives on the `main`
branch of `reggie-db/dbx-tools`.
