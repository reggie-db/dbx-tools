# @dbx-tools/projen

Projen engine for dbx-tools pnpm workspaces.

Import this package from `.projenrc.ts` when a repository should discover
packages from the filesystem and generate manifests, tsconfigs,
barrels, OpenAPI clients, codegen outputs, and release tasks.

Key features:

- Filesystem package discovery: every `src`-bearing folder under configured
  workspace roots becomes a TypeScript package.
- Tag-driven runtime defaults for shared libraries, Node packages, CLIs,
  servers, OpenAPI clients, and React/Vite UI packages.
- Generated package manifests, tsconfigs, package-root barrels, Vite configs,
  pnpm workspace/catalog files, and VS Code settings.
- Extensible mixin system so repositories can add deps, tasks, or generated
  files based on package predicates.
- OpenAPI client generation from tsoa controllers and zod schema generation from
  `.d.ts` inputs.
- Read-only generated-file stamping, cleanup, and watch-loop helpers.

## Define A Workspace Root

```ts
import { project as projenProject } from "@dbx-tools/projen";

const project = new projenProject.DBXToolsNodeProject({
  name: "my-apps",
  scope: "my-apps",
  packageRoots: ["packages", "examples"],
});

project.synth();
```

Every `src`-bearing folder under the configured roots becomes a
`DBXToolsTypeScriptProject`. Folder path drives package name and runtime tags.

Dependency installation runs once from this root. The default-on
`ROOT_INSTALL_ONLY_MIXIN` clears child `install` / `install:ci` task steps during
root pre-synthesis, including packages attached after root construction. Set
`rootInstallOnly: false` only when a repository intentionally wants projen's
per-project installation behavior.

The engine treats generated barrels, tests, declaration files, and folders
without exported source modules as implementation details. They do not create
new package membership.

## Add A Python uv Workspace

`DBXToolsPythonWorkspace` attaches Python packaging to an existing projen root
without turning Python packages into JavaScript workspace projects. It generates
the root and member `pyproject.toml` files, standard `py:*` tasks, the VS Code
interpreter setting, and an optional manual PyPI trusted-publishing workflow.

```ts
import { project, projectPy } from "@dbx-tools/projen";

const root = new project.DBXToolsNodeProject({ name: "my-apps" });
const repository = {
  url: "https://github.com/example/my-apps.git",
  ref: "main",
  root: "python/packages",
} as const;

new projectPy.DBXToolsPythonWorkspace(root, {
  repository,
  packages: [
    {
      directory: "core",
      name: "my-apps-core",
      module: "my_apps.core",
      description: "Shared Python helpers",
    },
  ],
  interpreterPath: "${workspaceFolder}/python/.venv/bin/python",
  release: true,
});
```

Use `projectPy.pythonGitDependency(repository, name, directory)` for an internal
dependency that must also resolve when a package is installed directly through a
Git `#subdirectory=` URL. `root.vscode` is projen's existing VS Code component;
dbx-tools reuses it rather than constructing a second `.vscode/settings.json`
owner.

## Customize Packages With Mixins

```ts
import { project as projenProject } from "@dbx-tools/projen";

const project = new projenProject.DBXToolsNodeProject();

projenProject.applyToProjects(project, { tags: "shared" }, (pkg) => {
  pkg.addDeps("zod@catalog:");
});

project.synth();
```

`applyToProjects` AND-s its globs (prefix a glob with `!` to negate) into one
predicate over the DBXTools child packages, then applies it as a `constructs`
mixin across the subtree. Filter on the folder (`path`), the tags (`tags`), or
the name from whichever angle fits: `name` matches the raw projen name verbatim,
while `identifierPackageName`, `identifierScope`, and `identifierName` match the
parsed `@scope/name`, its scope, and its unscoped half. Two flags widen the
selection past DBXTools children - `includeRoots` for the tree root and
`includeNonDBXToolsProjects` for plain projen projects (which widens the callback
parameter to `Project`). Drop to `mixin.create(predicate, fn)` +
`project.with(...)` only when you need a predicate the filters cannot express.

Built-in tag mixins set runtime defaults for `shared`, `node`, `cli`, `server`,
`ui`, and `openapi`. Repo-specific mixins layer package-specific dependencies,
scripts, and generated files on top.

A tag layers over a shared compiler floor every package gets at construction:
ES2022 plus the web-platform globals available in every runtime, and deliberately
no DOM lib and no Node types, so agnostic code stays isomorphic. The tags are what
add an environment on top - `node` adds Node types, `ui` adds the DOM lib. That
floor is also where `jsx` lives, for a reason worth knowing before moving it:
packages resolve each other to SOURCE, so a consumer type-checks its dependency's
files under its own tsconfig. The moment any package re-exports a `.tsx` module,
every package that imports it - however far down the graph, whatever its tag -
fails with `TS6142: ... but '--jsx' is not set`. Setting `jsx` per consumer is the
wrong fix, since the consumer authors no JSX and cannot know a transitive
dependency started to. The option is inert without JSX in the graph: it selects
how JSX syntax compiles and adds no lib, global, or type dependency.

## Work With Package Discovery

```ts
import { packages } from "@dbx-tools/projen";

const discovered = packages.scanPackages(process.cwd(), ["packages"]);
const recorded = packages.recordedPackages();
```

`scanPackages()` reads the filesystem during synth. `recordedPackages()` reads
the generated `pnpm-workspace.yaml` plus package manifests for post-synth tools.
Use the latter for docs, linting, and release checks that should match the
recorded workspace.

## Generate Barrels And Codegen

```ts
import { barrels, codegen } from "@dbx-tools/projen";

codegen.generateCodegen();
barrels.generateBarrels();
```

`generateCodegen()` reads `package.json` `codegen.inputs` and writes generated
schema modules. They are written read-only, and the root ESLint task runs with
`--fix` (which fails on a read-only file), so each generated module is added to
`ignorePatterns` at synth - named individually via `codegen.codegenModulePaths()`,
never as a blanket `<package>/src/**`. A codegen package may hold hand-written
modules beside its generated ones, and those must stay linted.

`generateBarrels()` writes package-root `index.ts` barrels with module
namespaces and flat unique type exports, returning the number that actually
changed. A name two modules both declare is ambiguous and stays namespace-only —
except when one of them is generated: the hand-written module is the curated view
of the generated shape (`shared-genie`'s `genie-model.ts` extends its own
codegen'd `dashboards.ts`), so it owns the name and stays hoisted. A barrel whose export surface is unchanged is left untouched,
read-only bit included, so concurrent writers never collide over it. Every
package is attempted even if one fails; the failures are re-thrown together as an
`AggregateError` naming each package, rather than the first one abandoning the
rest of the sweep.

## Generate OpenAPI Clients

```ts
import { openapi } from "@dbx-tools/projen";

const packages = await openapi.generateOpenapi();
```

OpenAPI generation scans packages for tsoa controllers, emits `openapi.json`,
generates TypeScript schemas, and adds an `openapi-fetch` client.

## Configure pnpm Catalogs

```ts
project.pnpmWorkspace?.addCatalog("react", "^19");
project.pnpmWorkspace?.allowBuild("esbuild");
```

projen's native `javascript.PnpmWorkspaceYaml` writes `pnpm-workspace.yaml`;
`pnpmWorkspace.PnpmWorkspaceState` supplies the options it renders and tracks
package members, catalog entries, and build-script allowances. Any other pnpm
setting goes through the root's `workspaceYaml` option, which is projen's typed
`PnpmWorkspaceYamlOptions`:

```ts
new DBXToolsNodeProject({ workspaceYaml: { overrides: { glob: "^13.0.0" } } });
```

`allowBuild` writes pnpm's `allowBuilds` map rather than projen's own
`allowScripts` option, which for pnpm renders `onlyBuiltDependencies` - a key
current pnpm does not read, so the list would leave every build script skipped.
Only allowances are declared; a dependency that is never allowed needs no entry,
because pnpm warns and moves on.

The engine also applies `catalogMode: manual` (keeps `pnpm add` out of the
generated catalog) and `verifyDepsBeforeRun: warn`. The file is emitted for the
tree ROOT only; a member package never gets a nested one.

## Clean And Watch Generated Files

```ts
import { clean, watch } from "@dbx-tools/projen";

const generated = clean.listGeneratedFiles();
watch.watchLoop({
  roots: watch.watchRoots(),
  onChange: async (files) => console.log(files),
});
```

Use these modules for maintenance tasks that should follow the same generated
file contract as the CLI.

## Modules

- `project` - `DBXToolsNodeProject`, `DBXToolsTypeScriptProject`, package naming,
  compiler/task helpers.
- `mixin` / `projectPredicate` - constructs mixin factory and package
  predicates.
- `tags` - built-in runtime tag mixins and compiler floors.
- `packages` - filesystem discovery and recorded package metadata.
- `pnpmWorkspace` - generated pnpm workspace file and catalog model.
- `barrels` / `moduleExports` - public entrypoint generation.
- `codegen` - `.d.ts` to zod schema generation.
- `openapi` - tsoa/OpenAPI package generation.
- `bunApp` / `tsconfig` / `vscode` - generated support files/components.
- `generated` / `clean` / `watch` / `scaffold` - read-only file stamping,
  cleanup, watchers, and synth orchestration.
- `publish` - packaging and tag-based release helpers.
- `engineRoot` - engine package root resolution for bootstrapped repos.

The engine registers its commands as projen tasks on the workspace root, so run
them with `bun run <task>` - `sync` (add `--watch`), `barrels`, `openapi`, and
`clean`.
[`@dbx-tools/cli`](../packages/js/cli/dbx-tools) is only needed to
bootstrap a folder that has no `.projenrc.ts` or toolchain yet.

## Run Tasks From The ROOT

Every repo-wide task lives on the root, and the root's `compile` / `test`
delegate with `bun run --filter '*'` rather than emitting a step per member - so
a new package is covered without a re-synth. Work from the root:

| Task              | What it does                                          |
| ----------------- | ----------------------------------------------------- |
| `bun run build`   | workspace `compile` + `test`; no root package fan-out |
| `bun run compile` | `tsc --build` in each member, in parallel             |
| `bun run test`    | `eslint` once, then each member's tests               |
| `bun run sync`    | re-synth (`--watch` to keep synthing)                 |
| `bun run barrels` | regenerate the read-only `index.ts` barrels           |
| `bun run bump`    | version, tag, and publish                             |

`bump` also mirrors a release into local registries when the active clients are
pointed at loopback services. npm uses `npm config get registry` and publishes
to a local Verdaccio automatically. Publishable JavaScript members compile once
from the root in parallel, then upload through a bounded pool without rerunning
their `prepack` tasks. When synth already made the manifests and Bun workspace
lock release-current, publishing also skips redundant version stamping and the
lockfile reinstall. Python prefers uv's default index and only
treats a loopback `.../+simple/` URL as writable devpi; a read-only cache such as
proxpi (`.../index/`) is deliberately ignored. The task stamps every Python
member and its sibling dependencies to the release version, builds the workspace
with uv, then runs `devpi upload --from-dir` against the derived writable index.
The npm and Python mirrors run concurrently because they touch disjoint package
trees. Devpi client authentication remains in its normal `~/.devpi` state.

Use `--local-registry false` or `--local-pypi false` to disable either local
publish. An explicit `--local-pypi http://localhost:3141/user/index/` overrides
auto-detection; `--python-root` defaults to `packages/py`.

The pushed `v*` tag is also the public release boundary: it triggers npm
publishing, stamps and publishes every Python distribution to PyPI, and rebuilds
and deploys the documentation site. Ordinary pushes to `main` publish none of
those surfaces.

Members intentionally keep only the tasks that something OTHER than a human
invokes, so there is no second place to run the same thing:

- `compile` / `test` - what the root's `--filter '*'` delegation calls.
- `prepack` - standalone-publish safety that compiles one package before packing
  (27 of 33 members; the workspace release driver compiles them from the root
  and publishes with lifecycle scripts disabled).
- `watch` - a single-package `tsc --build -w`, for narrowing a long
  edit/compile loop to one package.
- `build` / `package` - a complete compile/test/pack lifecycle when invoked in
  one package. Root bump deliberately bypasses these and uses filtered compile
  plus concurrent `bun publish --ignore-scripts`. The package phase also packs
  with `--ignore-scripts` because its build already compiled; `prepack` remains
  available for a standalone publish that did not run `build` first.
- `install` / `install:ci` / `default` / `pre-compile` / `post-compile` -
  projen's lifecycle scaffolding, emitted for every member because its task model
  expects them.

Do NOT run `projen default` (or `bunx projen`) from inside a member. Synth is a
whole-tree operation driven by the ROOT `.projenrc.ts`, so a member-level run
re-synths the entire workspace from the member's directory. Run `bun run sync`
from the root instead.

## Versioning

The whole repo shares ONE version, stored in the root `VERSION` file (a plain
`x.y.z` string; a fresh tree with no file defaults to `0.0.1`). Synth COPIES that
value into every generated manifest - the root and `projen/` `package.json`, every
JS member, every Python `pyproject.toml`, the generated openapi packages, and the
example apps - so the packages, the engine, and the examples always match.
`src/workspace-version.ts` owns reading and writing it. Synth only ever reads it;
it never resets, upgrades, or downgrades a version on its own.

`bun run bump` is the only command that changes the number: it fetches the remote
tags once, takes the highest tag across `v*` and every sibling prefix as the base
(falling back to the local `VERSION` file when the remote is unreachable or has no
tag), increments by `--level`, writes `VERSION`, then synths so every manifest
copies it. The remote is consulted only on `bump` and on one-time creation of a
missing `VERSION` file - never on an ordinary synth.
