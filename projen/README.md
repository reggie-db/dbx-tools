# @dbx-tools/projen

Projen engine for Bun-first dbx-tools workspaces.

Import this package from `.projenrc.ts` when a repository should discover
packages from the filesystem and generate manifests, tsconfigs,
barrels, codegen outputs, and release tasks.

Key features:

- Filesystem package discovery: every `src`-bearing folder under configured
  workspace roots becomes a TypeScript package.
- Tag-driven runtime defaults for shared libraries, Node packages, CLIs,
  servers, and React/browser UI packages.
- Generated package manifests, tsconfigs, package-root barrels, Bun app configs,
  VS Code settings, and a committed `pnpm-workspace.yaml` retained for
  Databricks Apps deployment.
- Extensible mixin system so repositories can add deps, tasks, or generated
  files based on package predicates.
- Zod schema generation from `.d.ts` inputs.
- Read-only generated-file ownership, cleanup, and watch-loop helpers.

## Define A Workspace Root

```ts
import { project } from "@dbx-tools/projen";

const rootProject = new project.DBXToolsNodeProject({
  name: "my-apps",
  scope: "my-apps",
  packageRoots: ["packages", "examples"],
});

rootProject.synth();
```

Every `src`-bearing folder under the configured roots becomes a
`DBXToolsTypeScriptProject`. Folder path drives package name and runtime tags.

Use `DBXToolsTypeScriptProject` itself as the root when one package needs the
same Bun workspace, repository, task, and release defaults without a separate
non-compiling root. It preserves Projen's native compiling `tsconfig.json`
instead of creating a second owner. An explicit `outdir` is the workspace root
for naming, Git metadata, package discovery, codegen, and barrels even when the
calling process has a different current directory.

The unified dbx-tools release surface is enabled by default. `bump` increments
the local `VERSION` and synchronizes generated version surfaces. `release`
commits that bump on the configured release branch, pushes it, and pushes an
annotated version tag. The generated GitHub workflow runs only for matching tag
pushes and publishes directly from that immutable commit. Set
`releaseMode: "disabled"` to omit the workflow and bump/version/release tasks.
The inherited Projen `release` and `releaseTrigger` options are intentionally
not part of this engine's public options because they create a competing release
workflow.

Repository policy stays in the consuming `.projenrc.ts`:

- `releaseDocs` supplies repository-defined preparation and build steps plus
  the Pages artifact path. The engine adds release checkout, artifact upload,
  and deployment without naming a docs script or output tree.
- `releasePythonRoot` passes the actual Python package root to local release
  preparation. Omit it when the workspace has no standard Python packages.
- `releaseValidationTasks` names repository tasks that must pass in tag CI
  before release artifacts are built and published.
- `releaseSetupSteps` installs any extra validation/build prerequisites in the
  shared release job before the validation tasks run.
- `releaseSynthesisCommands` runs repository-specific synth owners before the
  root synthesis and clean-diff release check.
- `extraWorkspaceMembers` declares self-synthesizing tooling packages outside
  `packageRoots`. Their version, generated entrypoint, formatting, linting, and
  workspace membership are derived from that declaration.

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
Projen's native `PyprojectTomlFile` owns generated TOML formatting. Temporary
release packaging copies each project to an isolated directory and projects
sibling registry requirements there with parsed TOML. Source manifests already
carry the root `VERSION` and are never rewritten for publication.

```ts
import { project, projectPy } from "@dbx-tools/projen";

const root = new project.DBXToolsNodeProject({ name: "my-apps" });

new projectPy.DBXToolsPythonWorkspace(root, {
  root: "python/packages",
  packages: [
    {
      directory: "core",
      description: "Shared Python helpers",
    },
    {
      directory: "service",
      description: "Python service",
      internalDependencies: ["core"],
    },
  ],
  release: true,
});
```

Distribution names and modules come from the parent scope plus each package
directory. The repository comes from the parent project metadata or Git remote.
`internalDependencies` renders standalone Git `#subdirectory=` requirements
without repeating repository coordinates. Pass `repository`, `name`, or
`module` only to override those conventions. `root.vscode` is projen's existing
VS Code component; dbx-tools reuses it rather than constructing a second
`.vscode/settings.json` owner.

### Bundle Node Code For PythonMonkey

Add `nodeBindings` to any `DBXToolsPythonWorkspace` package to generate
committed CommonJS runtimes and Python wrappers from public Node packages. Pass
one binding object or an array. Projen writes one
`[tool.dbx_tools.node_bindings]` table or multiple
`[[tool.dbx_tools.node_bindings]]` tables accordingly, so generation also works
in consuming repositories after `@dbx-tools/projen` is installed.

```ts
new project.DBXToolsPythonWorkspace(root, {
  root: "packages/py",
  packages: [
    {
      directory: "node-runtime",
      name: "dbx-tools-node-runtime",
      module: "dbx_tools.node_runtime",
      description: "Shared PythonMonkey runtime and lazy Node.js bootstrap",
      nodeRuntime: true,
    },
    {
      directory: "postgres",
      description: "Python bindings for example Postgres helpers",
      nodeBindings: [
        {
          package: "@example/postgres",
          modules: ["identity", "config"],
        },
        {
          package: "@example/lakebase",
          modules: ["address"],
        },
      ],
    },
  ],
});
```

Bindings always live under
`<python-module>/_generated/node/`. Each Python package receives one shared
`_runtime.js`; typed wrappers live under `<node-package>/<module>.py`. This
preserves Node module singleton identity across all bindings in the Python
process. The intermediate directories remain implicit namespace packages with
no generated `__init__.py`. Omit `modules` to discover every exported package
namespace that contains plain functions, or supply one module string or an array
explicitly.
Generated wrappers convert public function names to `snake_case`, preserve
synchronous functions, await promises, recursively convert plain records and
arrays, and proxy returned JavaScript class instances with `snake_case` async
methods.

Every function parameter is resolved through the TypeScript compiler API and
rendered with its Python-equivalent name and type. Supported record types become
keyword-only Python dataclasses, nested records become nested dataclasses, and a
same-named exported companion's `defaults()` method supplies field defaults. A
record parameter can be passed as the generated dataclass or a dictionary.
Generation fails with the property path when a type cannot be represented safely
in Python.

Return types use the same compiler model. Plain records become generated
`TypedDict` responses, returned clients and class instances become `Protocol`
types with typed async methods, and primitives, arrays, maps, promises, and
optional values retain their corresponding Python annotations.

The generator resolves portable Node built-ins through standard browser
polyfills. Generated bundles proxy Python-host-backed built-ins to
`dbx-tools-node-runtime`, which owns the process, file, crypto, OS, abort,
headers, and runtime bootstrap shims. Packages do not configure or copy a shim
directory, and their generated Python loader imports the shared runtime package.

`nodeRuntime: true` identifies the one workspace package that owns
`build-runtime.ts`, `shims/`, the generated `runtime.js`, PythonMonkey bootstrap,
and bundle loading. Its distribution and module must be
`dbx-tools-node-runtime` and `dbx_tools.node_runtime`. Packages with
`nodeBindings` automatically depend on that workspace member. When the workspace
does not publish the runtime itself, they receive the matching external
`dbx-tools-node-runtime` dependency instead.

The workspace creates one repository-wide binding lifecycle:

- `python-node-bindings` generates every configured bridge.
- `python-node-bindings:check` verifies generated files and fails on stale
  `_generated/node` directories.
- `python-node-bindings:watch` watches only configured module entrypoints and
  their transitive workspace source imports. Tests, compiled output, generated
  bindings, and unrelated modules do not trigger regeneration or acquire the
  workspace mutation lock. Binding-manifest and generator changes regenerate
  the affected projects and restart the watcher when its input graph changes.

When a runtime owner is configured, the workspace also creates one shared
runtime lifecycle:

- `python-node-runtime` runs the package-owned `build-runtime.ts`.
- `python-node-runtime:check` verifies the committed `runtime.js`.
- `python-node-runtime:watch` watches `build-runtime.ts` and `shims/` and runs
  the same package-owned builder.

`bun run sync --watch` supervises both generic watchers alongside the existing
`projenrc` and `barrels` watchers. No per-Python-package watcher tasks are
created. Full synthesis regenerates every binding and reconciles stale
`_generated/node` trees with the current `pyproject.toml` files.
Built-in shims can make ordinary Node imports work under PythonMonkey.
`functionOverrides` replaces named exports only in the generated runtime, so the
Node package does not gain Python callbacks or alternate source files. A
replacement may use a different export name through `handlerExport`; every
other export continues to come from the original module.

### Synchronize Pinned Python Sources

Use a package's `sync` field when published Python code must include a reviewed
subset of a Git repository instead of exposing a direct URL dependency:

```ts
{
  directory: "service",
  description: "Python service with synchronized upstream code",
  sync: [
    {
      name: "upstream_driver",
      source:
        "driver @ git+https://github.com/example/project.git@0123456789abcdef0123456789abcdef01234567#subdirectory=src/driver",
      include: ["driver.py", "operations/**/*.py"],
      exclude: ["**/test_*.py"],
      replace: {
        "DEFAULT_TIMEOUT = 30": "DEFAULT_TIMEOUT = 120",
      },
    },
  ],
}
```

Each source is written beneath
`<python-module>/_generated/sync/<name-or-owner-repository-hash>`. The generated
package task parses pip-style Git sources, filters files with the configured
globs, applies and verifies every literal `replace` patch, records the options
and resolved commit in `.sync.json`, and recursively marks the result read-only.

Do not hard-code the generated package path in `replace`. `localizeImports`
(on by default for identifier names) parses each file with the Python AST and
rewrites absolute imports of synchronized modules, whether upstream imports them
bare (`from operations.base import X`) or under the subdirectory's dotted path
(`from src.driver.operations.base import X`). It also rewrites constant
`__import__` and `importlib.import_module` arguments. Pass a list of upstream
module names to rewrite only those (each must match), or `false` to keep upstream
imports. The import prefix comes from the same constants as the output path, so
renaming the module or generated directory flows through without config edits.

Synchronization uses a check-lock-check sequence and an atomic directory
replacement. A current pinned commit performs no network request. Branches and
tags use `git ls-remote` to detect upstream movement. Run the generated
`<package>:python-sync:check` task in validation, or pass `--force` to refresh a
current source intentionally.

## Customize Packages With Mixins

```ts
import { project } from "@dbx-tools/projen";

const rootProject = new project.DBXToolsNodeProject();

project.applyToProjects(rootProject, { tags: "shared" }, (pkg) => {
  pkg.addDeps("zod@catalog:");
});

rootProject.synth();
```

Use `projectJs.addOptionalPeer(pkg, specifier)` for an optional peer that must
also resolve during local development. It writes the peer metadata and matching
development dependency without turning the peer into a runtime dependency.

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
and `ui`. Repo-specific mixins layer package-specific dependencies,
scripts, and generated files on top.

AppKit 0.81's `appkitServerConfig()` is the preferred tsdown preset for a
consumer app using conventional compiled `server/agents/*/agent.ts` entries. It
does not replace this engine's package discovery, Bun browser build, source-run
server, publication, or Databricks deployment staging.

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

Add declaration inputs through the owning package's typed config:

```ts
pkg.dbxToolsConfig.codegenInputs.push("node_modules/example/model.d.ts");
```

`generateCodegen()` reads the serialized `dbxToolsConfig.codegenInputs` and
writes generated schema modules. They are written read-only, and the root
ESLint task runs with an explicit separate fix task, so each generated module is
added to `ignorePatterns` at synth - named individually via
`codegen.codegenModulePaths()`, never as a blanket `<package>/src/**`. A codegen
package may hold hand-written modules beside its generated ones, and those must
stay linted.

`generateBarrels()` writes package-root `index.ts` barrels with module
namespaces, flat unique type exports, and `PACKAGE_IDENTIFIER`, returning the
number that actually changed. A name two modules both declare is ambiguous and stays namespace-only,
except when one of them is generated: the hand-written module is the curated view
of the generated shape (`shared-genie`'s `genie-model.ts` extends its own
codegen'd `dashboards.ts`), so it owns the name and stays hoisted. A barrel whose export surface is unchanged is left untouched,
read-only bit included, so concurrent writers never collide over it. Every
package is attempted even if one fails; the failures are re-thrown together as an
`AggregateError` naming each package, rather than the first one abandoning the
rest of the sweep.

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
watch.watchLoop("workspace", watch.watchRoots(), async (files) => refresh(files));
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
- `bunApp` / `tsconfig` / `vscode` - generated support files/components.
- `generated` / `clean` / `watch` / `scaffold` - read-only file ownership,
  cleanup, watchers, and synth orchestration.
- `publish` - packaging and tag-based release helpers.
- `engineRoot` - engine package root resolution for bootstrapped repos.

The engine registers its commands as projen tasks on the workspace root, so run
them with `bun run <task>` - `sync` (add `--watch`), `barrels`, `clean`, and the
configured `python-node-bindings:*` and `python-node-runtime:*` lifecycles.
[`@dbx-tools/cli`](../packages/js/cli/dbx-tools) is only needed to
bootstrap a folder that has no `.projenrc.ts` or toolchain yet.

## Run Tasks From The ROOT

Every repo-wide task lives on the root. `compile` batches package tsconfigs in
up to four `tsc --build` processes and runs package-owned compile lifecycles
alongside them; `test` delegates with `bun run --filter '*'`. Both read the
current workspace list, so a new package is covered without a re-synth. Work
from the root:

| Task                    | What it does                                        |
| ----------------------- | --------------------------------------------------- |
| `bun run build`         | synth + workspace compile and tests                 |
| `bun run compile`       | Batched `tsc --build` plus custom member compiles   |
| `bun run test`          | `eslint` once, then each member's tests             |
| `bun run sync`          | re-synth (`--watch` to keep synthing)               |
| `bun run barrels`       | regenerate the read-only `index.ts` barrels         |
| `bun run bump`          | increment `VERSION` and regenerate version surfaces |
| `bun run version:check` | verify every generated version against `VERSION`    |
| `bun run release`       | run the configured release transaction              |

Run `bun run release` from any branch. Pending changes are committed and
the current branch is pushed first. A non-`main` branch then fast-forwards
`main`; the command fails without creating a merge commit if either branch has
diverged. From `main`, it calls the existing `bump` task, commits the generated
version changes, pushes `main`, and pushes the matching annotated `vX.Y.Z` tag.
Pass `--no-bump` only to release an existing synchronized local bump. The tag
workflow verifies that the tag points at the exact `origin/main` commit. One
`build-release` job installs workspace dependencies, runs validation, packs the
npm archives, builds all Python distributions, and builds the documentation
site. Install validation prerequisites through `releaseSetupSteps`;
`releaseDocs.prepareSteps` runs after validation.

Publication jobs download the resulting artifacts rather than rebuilding the
workspace. Each Python package retains its own publishing environment and waits
for its package dependencies to publish. The npm job uses the bundled archive
publisher without a checkout or workspace install. Pages deploys the already
built site after registry publication succeeds. Local npm and Python registry publication remains available
through the direct local publication tooling.

The default release still publishes npm, Python, and docs, then publishes to
configured local registries automatically. Select a scope or disable individual
steps for one run without changing the Projen definition:

```sh
bun run release --publish pypi --no-docs
bun run release --no-npm --no-local-publish
bun run release --publish local --install never
bun run release --local-registry false --local-pypi auto
bun run release --demo-deploy
bun run release --no-release-notes
bun run release --release-notes-instructions "Focus on operator-visible changes."
```

`--demo-deploy` is off by default. After tagging and any local registry
publication it runs `bun run demo:deploy`, which stages the AppKit demo
from locally compiled Node packages and locally built Python wheels, resolves
the configured/default workspace profile through `@dbx-tools/auth`, and deploys
it. That step is local only and is not recorded in the annotated tag.

After bump and configured validation, release writes
`docs/releases/vX.Y.Z.md` with `dbx genie exec -C "$PWD" --sandbox read-only
--ephemeral -o`. The standard prompt forbids running tests or other validation
commands. If Genie fails or writes an empty file, the step keeps going with a
short git-log summary. `--no-release-notes` skips the file.
`--release-notes-instructions` appends run-specific guidance to the standard
Genie prompt. Notes are committed with the version bump and are not recorded in
the annotated tag. They are skipped on `--no-bump` because that path requires an
already committed tree.

`--install auto` keeps Projen's normal local dependency-install behavior;
`always` performs a manifest-resolved install first, and `never` uses dependencies already
installed while still regenerating versioned sources. Local release validation
runs `eslint:fix` before branch preparation and bump, then runs the selected
fail-closed tasks; CI remains check-only.
`--no-validation` skips optional task checks locally and in CI, not version or immutable-source checks.
`--no-docs` skips building and deploying the site, not package README validation.
Scopes select artifacts, not the normal commit and tag-push transaction.
The annotated tag records CI step selections, so publishing a selected scope does
not change the next release's defaults. Local registry URLs stay local.

Members intentionally keep only the tasks that something OTHER than a human
invokes, so there is no second place to run the same thing:

- `compile` / `test` - what the root's `--filter '*'` delegation calls.
- `prepack` - standalone-publish safety that compiles one package before packing
  when that package has a compiled publication surface; the workspace release
  driver compiles from the root and publishes with lifecycle scripts disabled.
- `watch` - a single-package `tsc --build -w`, for narrowing a long
  edit/compile loop to one package.
- `build` / `package` - a complete compile/test/pack lifecycle when invoked in
  one package. Release preparation validates through the root's filtered tasks,
  and publication uploads archives that were each packed and
  validated once with lifecycle scripts disabled. The package phase also packs
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

`VERSION` is the language-neutral version seam. Real package manifests remain
Projen-owned and reproduce it exactly across JavaScript and Python packages.
Release jobs publish the generated workspace inventory in dependency-safe
workflow order without introducing another version owner.

<!-- cli-reference:start -->

## Command Reference

### `release`

Prepare an annotated release and select its build and publication steps

```sh
release [options]
```

#### Options

| Option                                | Description                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `--root <path>`                       | repository root                                                                               |
| `--branch <name>`                     | release branch (default: "main")                                                              |
| `--prefix <prefix>`                   | release tag prefix (default: "v")                                                             |
| `--remote <name>`                     | git remote (default: "origin")                                                                |
| `--python-root <path>`                | Python package root for local publish (default: "packages/py")                                |
| `--validate <task>`                   | task to run before pushing (default: [])                                                      |
| `--no-bump`                           | use an existing synchronized local version bump                                               |
| `--publish <target>`                  | publication scope (choices: "auto", "npm", "pypi", "local", "none", default: "auto")          |
| `--install <mode>`                    | local workspace dependency installation (choices: "auto", "always", "never", default: "auto") |
| `--no-npm`                            | skip npm build and publication, including local npm publication                               |
| `--no-pypi`                           | skip Python build and publication, including local Python publication                         |
| `--docs`                              | build and deploy docs for a selected scope                                                    |
| `--no-docs`                           | skip documentation build and deployment                                                       |
| `--no-validation`                     | skip optional release validation tasks; version/source checks remain mandatory                |
| `--no-release-notes`                  | skip writing docs/releases notes (Genie and git-log fallback)                                 |
| `--release-notes-instructions <text>` | append custom instructions to the Genie release-notes prompt                                  |
| `--demo-deploy`                       | after tagging, stage and deploy the AppKit demo app (off by default)                          |
| `--no-local-publish`                  | skip publishing to configured local registries                                                |
| `--local-registry <auto\|false\|url>` | local npm registry selection (default: "auto")                                                |
| `--local-pypi <auto\|false\|url>`     | local devpi registry selection (default: "auto")                                              |

<!-- cli-reference:end -->
