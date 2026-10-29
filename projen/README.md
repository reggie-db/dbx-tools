# @dbx-tools/projen

Use this Projen engine from `.projenrc.ts` to discover packages and generate
manifests, tsconfigs, barrels, schemas, and release tasks for Bun-first
dbx-tools workspaces.

## Define a workspace root

```ts
import { projectJs } from "@dbx-tools/projen";

const rootProject = new projectJs.DBXToolsNodeProject({
  name: "my-apps",
  scope: "my-apps",
  packageRoots: ["packages", "examples"],
});

rootProject.synth();
```

The project discovers every `src`-bearing folder under the configured roots and
applies defaults for shared libraries, Node packages, CLIs, servers, and React
packages. It can also generate Zod schemas from declarations and coordinate
generated-file cleanup and watch tasks.

Every `src`-bearing folder under the configured roots becomes a
`DBXToolsTypeScriptProject`. `packages/js` is selected automatically when it
exists; otherwise discovery uses `packages`. Folder path drives package name and
runtime tags.
Use `packageDefaults` for native options shared by every discovered package,
such as `{ publishable: false }`; reserve `resolvePackageOptions` for genuine
per-package differences. Use `rootTsconfig` only for repository-wide compiler
differences; root tests, Bun/Node types, and React JSX are already included.

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
- `releasePythonRoot` passes the configured Python package root to local release
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

## Add a Python uv workspace

`DBXToolsPythonWorkspace` attaches Python packaging to an existing projen root
without turning Python packages into JavaScript workspace projects. It generates
the root and member `pyproject.toml` files, standard `py:*` tasks, the VS Code
interpreter setting, and an optional manual PyPI trusted-publishing workflow.
Projen's native `PyprojectTomlFile` owns generated TOML formatting. Temporary
release packaging copies each project to an isolated directory and projects
sibling registry requirements there with parsed TOML. Source manifests already
carry the root `VERSION` and are never rewritten for publication.

```ts
import { projectJs, projectPy } from "@dbx-tools/projen";

const root = new projectJs.DBXToolsNodeProject({ name: "my-apps" });

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
directory. Direct children of the Python root that contain `src/` are discovered
automatically; `packages` only needs entries whose metadata differs from the
generated defaults. Set `discoverPackages: false` for a fully explicit list.
The repository comes from the parent project metadata, existing generated root
manifest, or Git remote.
`internalDependencies` renders standalone Git `#subdirectory=` requirements
without repeating repository coordinates. Pass `repository`, `name`, or
`module` only to override those conventions. `root.vscode` is Projen's existing
VS Code component. dbx-tools reuses it rather than constructing a second
`.vscode/settings.json` owner.

### Bundle Node code for PythonMonkey

Add `nodeBindings` to any `DBXToolsPythonWorkspace` package to generate
committed CommonJS runtimes and Python wrappers from public Node packages. Pass
one binding object or an array. Projen writes one
`[tool.dbx_tools.node_bindings]` table or multiple
`[[tool.dbx_tools.node_bindings]]` tables accordingly, so generation also works
in consuming repositories after `@dbx-tools/projen` is installed.

```ts
import { projectJs, projectPy } from "@dbx-tools/projen";

const root = new projectJs.DBXToolsNodeProject({ name: "my-apps" });

new projectPy.DBXToolsPythonWorkspace(root, {
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
`_runtime.js`. Typed wrappers live under `<node-package>/<module>.py`. This
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
replacement may use a different export name through `handlerExport`. Every
other export continues to come from the original module.

### Synchronize pinned Python sources

Use a package's `sync` field when published Python code must include a reviewed
subset of a Git repository instead of exposing a direct URL dependency:

```ts
import { projectJs, projectPy } from "@dbx-tools/projen";

const root = new projectJs.DBXToolsNodeProject({ name: "my-apps" });

new projectPy.DBXToolsPythonWorkspace(root, {
  root: "packages/py",
  packages: [
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
    },
  ],
});

root.synth();
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
pinned source intentionally.

## Customize packages with mixins

```ts
import { project, projectJs } from "@dbx-tools/projen";

const rootProject = new projectJs.DBXToolsNodeProject();

project.applyToProjects(rootProject, { tags: "shared" }, (pkg) => {
  pkg.addDeps("zod@catalog:");
});

rootProject.synth();
```

Use `projectJs.addOptionalPeer(pkg, specifier)` for an optional peer that must
also resolve during local development. It writes the peer metadata and matching
development dependency without turning the peer into a runtime dependency.

`applyToProjects` combines its globs with AND logic. Prefix a glob with `!` to
negate it. The resulting predicate selects DBXTools child packages and applies
the callback as a `constructs` mixin across the subtree. Filter on the folder
(`path`), the tags (`tags`), or
the name from whichever angle fits: `name` matches the raw projen name verbatim,
while `identifierPackageName`, `identifierScope`, and `identifierName` match the
parsed `@scope/name`, its scope, and its unscoped half. Two flags widen the
selection past DBXTools children - `includeRoots` for the tree root and
`includeNonDBXToolsProjects` for plain projen projects (which widens the callback
parameter to `Project`). Drop to `mixin.create(predicate, fn)` +
`project.with(...)` only when you need a predicate the filters cannot express.

Built-in tag mixins set runtime defaults for `shared`, `node`, `cli`, `server`,
`ui`, and `app`. Repo-specific mixins layer package-specific dependencies,
scripts, and generated files on top. `ui` is for reusable React component
libraries. The generic `app` tag still owns a standalone Bun browser package.

One private Bun/AppKit application can live at `packages/app`, with browser
source under `client/` and backend source under `server/`. Set `appRoot` to
override that location or false to disable application-root discovery. AppKit
mode defaults to `auto` and configures the application whenever the root exists;
`appkit: true` additionally requires `client/index.html` and
`server/server.ts`. The engine generates the root Bun/TypeScript/AppKit
configuration, `client/vite.config.ts`, `app.yaml`, and a minimal direct-engine
bundle. Set `appBundle: false` when the application owns a richer
`databricks.yml`. Put repository-specific Vite settings in the unmanaged
`client/vite.config.override.ts`.

The generated `deploy` task validates with the native Bun build, then delegates
to `appkit:deploy` unless the repository already owns `deploy`. The AppKit task
runs `databricks apps deploy --skip-validation` with all forwarded arguments
from an isolated source snapshot, so the Databricks CLI never runs npm locally.
Because the remote builder selects npm when no portable pnpm lockfile is
uploaded, the snapshot replaces `catalog:` protocols with concrete versions.
When the application uses `workspace:` dependencies, the task packs their
transitive runtime workspace closure and links those archives from the staged
application, so deployment does not wait for a matching public release. Every
source manifest stays stable through upload and the generated working tree is
never modified. The task passes an explicit profile,
using the supplied flag or resolving one through `@dbx-tools/auth`, and fails
before staging when neither profile nor complete environment credentials are
available. It validates the bundle strictly, removes only stale direct-engine
state from the temporary snapshot, and defaults to active-run protection while
skipping duplicate npm validation and tests. If deployment or app startup
fails, the task prints the current Databricks App logs before returning the
original failure. A repository-owned deployment flow can run its own Bun checks
and spawn `appkit:deploy` for the upload step instead of maintaining staging or
materialization code.

Every workspace root exposes a generic development watcher:

```bash
bun run dev:watch <command> [args...]
```

It restarts after watched writes have been quiet for 15 seconds. Command paths
and task selectors identify the owning package. Its transitive workspace
dependencies are watched with the shared generated/dependency/test/temp ignores.
The configured restart key triggers an immediate restart. The demo uses this
task to run its concrete server entrypoint. The `server` tag does not assume one.

A tag layers over a shared compiler floor that every package receives at
construction: ES2022 plus the web-platform globals available in every runtime,
with no DOM library and no Node types. The tags add an environment on top.
`node` adds Node types, and `ui` adds the DOM library. The shared floor also
sets `jsx`.

Packages resolve each other to source, so a consumer type-checks its
dependency's files under its own tsconfig. If any package re-exports a `.tsx`
module, every transitive importer fails with
`TS6142: ... but '--jsx' is not set`. The consumer doesn't author that JSX and
can't track when a dependency starts exporting it, so the compiler floor owns
the setting. The option is inert without JSX in the graph. It selects how JSX
syntax compiles without adding a library, global, or type dependency.

Keep the generated tsconfigs package-local. Each package build config owns its
`rootDir`, declaration output, package-specific globals, and publish boundary.
Projen also places a no-emit config in each `test/` directory so TypeScript 6,
editors, and type-aware ESLint resolve the nearest project for test files. A
single config per runtime folder would merge package output boundaries and would
remove that nearest-config behavior. The runtime tag mixins already centralize
the environment differences without replacing the package configs.

Compilation preserves TypeScript's incremental cache. The root compile task
passes the package configs to batched `tsc --build` processes, and each config
retains its own `tsconfig.tsbuildinfo`. Synthesis also retains Projen's native
change detection: unchanged generated files are not rewritten, and dependency
installation runs only when the generated root manifest changes or
`node_modules` is absent. Repository discovery is process-cached so every child
package reuses the root probe instead of invoking `git`, `ssh`, and `gh` again.

## Work with package discovery

```ts
import { packages } from "@dbx-tools/projen";

const discovered = packages.scanPackages(process.cwd(), ["packages"]);
const recorded = packages.recordedPackages();
```

`scanPackages()` reads the filesystem during synth. `recordedPackages()` reads
the generated `pnpm-workspace.yaml` plus package manifests for post-synth tools.
Use the latter for docs, linting, and release checks that should match the
recorded workspace.

## Generate barrels and code generation

```ts
import { barrels, codegen } from "@dbx-tools/projen";

codegen.generateCodegen();
barrels.generateBarrels();
```

Add declaration inputs through the owning package's typed config:

```ts
import { project, projectJs } from "@dbx-tools/projen";

const rootProject = new projectJs.DBXToolsNodeProject({ name: "my-apps" });
project.applyToProjects(rootProject, { path: "packages/shared/generated" }, (pkg) => {
  pkg.dbxToolsConfig.codegenInputs.push("node_modules/example/model.d.ts");
});
rootProject.synth();
```

`generateCodegen()` reads the serialized `dbxToolsConfig.codegenInputs` and
writes generated schema modules. They are written read-only, and the root
ESLint task runs with an explicit separate fix task, so each generated module is
added to `ignorePatterns` at synth - named individually using
`codegen.codegenModulePaths()`, never as a blanket `<package>/src/**`. A codegen
package may hold hand-written modules beside its generated ones, and those must
stay linted.

`generateBarrels()` writes read-only entrypoints at the package root. Modules
directly under `src` go into `index.ts`; modules directly under
`src/example/wasm` go into `index.example.wasm.ts` and are importable through
`@scope/package/example/wasm`. The generator never writes nested
`src/**/index.ts` files or per-module package exports.

Generated barrels include module namespaces and conflict-free flat value and
type exports. The package root additionally exposes `PACKAGE_IDENTIFIER` and
`PACKAGE_VERSION`, even when no module lives directly under `src`. A name two modules
both declare is ambiguous and stays namespace-only, except when one is generated:
the hand-written module is the curated view of the generated shape
(`shared-genie`'s `genie-model.ts` extends its own codegen'd `dashboards.ts`), so
it owns the name and stays hoisted. An unchanged barrel remains untouched,
including its read-only bit, so concurrent writers do not collide. Every package
is attempted even if one fails. Failures are re-thrown together as an
`AggregateError` naming each package.

## Configure pnpm catalogs

```ts
import { projectJs } from "@dbx-tools/projen";

const rootProject = new projectJs.DBXToolsNodeProject({ name: "my-apps" });
rootProject.pnpmWorkspace?.addCatalog("react", "^19");
rootProject.pnpmWorkspace?.allowBuild("esbuild");
```

Projen's native `javascript.PnpmWorkspaceYaml` writes `pnpm-workspace.yaml`.
`pnpmWorkspace.PnpmWorkspaceState` supplies the options it renders and tracks
package members, catalog entries, and build-script allowances. Any other pnpm
setting goes through the root's `workspaceYaml` option, which is projen's typed
`PnpmWorkspaceYamlOptions`:

```ts
import { projectJs } from "@dbx-tools/projen";

const rootProject = new projectJs.DBXToolsNodeProject({
  name: "my-apps",
  pnpmOptions: {
    workspaceYamlOptions: {
      overrides: { glob: "^13.0.0" },
    },
  },
});
rootProject.synth();
```

`allowBuild` writes pnpm's `allowBuilds` map rather than projen's own
`allowScripts` option, which for pnpm renders `onlyBuiltDependencies` - a key
pnpm does not read, so the list would leave every build script skipped.
Only allowances are declared. A dependency that is never allowed needs no entry
because pnpm warns and moves on.

The engine also applies `catalogMode: manual`, which keeps `pnpm add` out of the
generated catalog, and `verifyDepsBeforeRun: warn`. The file is emitted for the
tree root only. A member package never gets a nested one.

## Clean and watch generated files

```ts
import { clean, watch } from "@dbx-tools/projen";

const generated = await clean.listGeneratedFiles();
const roots = watch.watchRoots();
```

Use these modules for maintenance tasks that should follow the same generated
file contract as the CLI. `watch.watchLoop()` accepts these roots and an
application-specific callback.

## Understand generation limits

- Change `.projenrc.ts` or another owning configuration source, then run
  `bun run sync` from the workspace root. Don't hand-edit generated files.
- Synthesis is a whole-tree operation. Don't run `bunx projen` or
  `projen default` from a member package.
- `packageRoots` discovery creates a package for each source-bearing directory.
  Generated folders, tests, and declaration-only folders don't create members.
- A single workspace version comes from `VERSION`. JavaScript and Python
  manifests reproduce it during synthesis.
- Python Node bindings support public functions and representable TypeScript
  types. Generation fails with a property path when a type can't be converted
  safely.
- Source synchronization requires a pinned Git source for reproducible
  publication. Branches and tags require a network lookup to detect movement.
- Release commands commit and push changes, tags, and selected publication
  artifacts. Review release options before you run `bun run release`.

## Use package modules

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

The engine registers its commands as Projen tasks on the workspace root, so run
them with `bun run <task>`, including `sync` (add `--watch`), `barrels`, `clean`, and the
configured `python-node-bindings:*` and `python-node-runtime:*` lifecycles.
[@dbx-tools/cli](../packages/js/cli/dbx-tools/README.md) is only needed to
bootstrap a folder that has no `.projenrc.ts` or toolchain yet.

## Run tasks from the root

Every repo-wide task lives on the root. `compile` batches package tsconfigs in
up to four `tsc --build` processes and runs package-owned compile lifecycles
alongside them. `test` delegates with `bun run --filter '*'`. Both read the
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
`main`. The command fails without creating a merge commit if either branch has
diverged. From `main`, it calls the existing `bump` task, commits the generated
version changes, pushes `main`, and pushes the matching annotated `vX.Y.Z` tag.
Pass `--no-bump` only to release an existing synchronized local bump. The tag
workflow verifies that the tag points at the exact `origin/main` commit. A newer
tag cancels the previous release run, including leftover publish, wait, and docs
jobs. The local task completes local publication and demo deployment first, then
waits for this workflow by default. It prints the initial job and step state, then only
append-only status changes, without annotations. Successful runs omit full logs;
unsuccessful runs print failed-step logs only. Local-only releases and
repositories without a resolved authenticated GitHub account skip the watcher.
Stopping the local watcher does not cancel the remote run.

One `build-release` job installs workspace dependencies, runs validation, packs
the npm archives, builds all Python distributions, and builds the documentation
site. Install validation prerequisites through `releaseSetupSteps`.
`releaseDocs.prepareSteps` runs after validation.

Publication jobs download the resulting artifacts rather than rebuilding the
workspace. Each Python package retains its own publishing environment and waits
for its package dependencies to publish. The npm job uses the bundled archive
publisher without a checkout or workspace install. If npm reports that a version
is already staged, that publisher waits for the public artifact instead of
publishing the version again. After all selected public publishers finish, one
verifier downloads the complete release artifact set and
polls only unresolved packages concurrently. It validates npm tarball contents
and PyPI distribution hashes before Pages deploys the already built site. Local
npm and Python registry publication remains available through the direct local
publication tooling and does not wait for registry propagation. Those local
publishers run concurrently; a failure or release termination stops every live
publisher before the command returns.

The default release publishes npm, Python, and docs, then publishes to
configured local registries. Use `bun run release --help` or the generated
[command reference](#release) for the complete option set. Common workflows:

```bash
bun run release
bun run release --publish pypi --no-docs
bun run release --publish local --install never
bun run release --demo-deploy --profile <profile>
```

Demo deployment is a local post-tag action. It stages locally compiled Node
packages and Python wheels, resolves credentials through
`@dbx-tools/auth`, including `DATABRICKS_CONFIG_PROFILE`, `DATABRICKS_HOST`,
and the other auth options, force-refreshes its token with interactive login
fallback, and deploys it. When auth selects a profile, the deploy passes that
resolved profile explicitly to every bundle command. The deployment selection
and profile are not recorded in the annotated tag.

After bump and configured validation, release writes
`docs/releases/vX.Y.Z.md` with `dbx genie exec -C "$PWD" --sandbox read-only
--ephemeral -o`. It first finds the newest tag whose GitHub Actions release
workflow succeeded, then asks Genie for cumulative notes from that deployed
baseline through HEAD. Newer failed-release tags and their notes remain source
material instead of shortening the delta to a retry-only workflow fix. The
standard prompt cannot run validation commands. Failures fall back to a short
git-log summary from the same successful baseline. Notes are committed with the
version bump, not stored in the annotated tag, and are omitted for an existing
committed bump.

Automatic installation retains Projen's manifest-based install trigger; the
other install modes force installation or reuse the current dependency tree.
Local release validation runs `eslint:fix` before branch preparation and bump,
then runs the selected fail-closed tasks. CI remains check-only and rebuilds
selected release artifacts instead of checking generated-source fingerprints.

Scopes select artifacts, not the normal commit and tag-push transaction.
The annotated tag records CI step selections, so publishing a selected scope does
not change the next release's defaults. Local registry URLs stay local.

Members keep only tasks that repository automation invokes, so there is no
second place for a contributor to run the same operation:

- `compile` / `test` - what the root's `--filter '*'` delegation calls.
- `prepack` - standalone-publish safety that compiles one package before packing
  when that package has a compiled publication surface. The workspace release
  driver compiles from the root and publishes with lifecycle scripts disabled.
- `watch` - a single-package `tsc --build -w`, for narrowing a long
  edit/compile loop to one package.
- `build` / `package` - a complete compile/test/pack lifecycle when invoked in
  one package. Release preparation validates through the root's filtered tasks,
  and publication uploads archives that were each packed and
  validated once with lifecycle scripts disabled. The package phase also packs
  with `--ignore-scripts` because its build already compiled. `prepack` remains
  available for a standalone publish that did not run `build` first.
- `install` / `install:ci` / `default` / `pre-compile` / `post-compile` -
  projen's lifecycle scaffolding, emitted for every member because its task model
  expects them.

Don't run `projen default` or `bunx projen` from inside a member. Synthesis is a
whole-tree operation driven by the root `.projenrc.ts`, so a member-level run
re-synths the entire workspace from the member's directory. Run `bun run sync`
from the root instead.

## Commit a registry-neutral lockfile

The root `bun.lock` is committed, and generated CI installs run
`bun install --frozen-lockfile`. A private npm mirror would otherwise appear in
every resolved tarball URL, so the generated `bun-lockfile` task runs after each
root install and as the root `postinstall` script, which also covers `bun add`,
`bun remove`, and `bun update`. It detects the active registry from the same
environment, `.npmrc`, `bunfig.toml`, and pnpm configuration a package manager
reads. When that registry is not public npm, it rewrites every tarball URL under
it and leaves all other URLs unchanged. Bun 1.4.2 has no native setting that
omits registry URLs from `bun.lock`.

The default replacement is an empty tarball field, which Bun resolves through
the installing machine's registry; integrity hashes still pin the content.
Run `bun run bun-lockfile -- --check` to confirm a lockfile is clean without
writing it. Options can also come from `PROJEN_BUN_LOCKFILE_*` environment
variables or `.env`.

## Manage workspace versions

`VERSION` is the language-neutral version seam. Real package manifests remain
Projen-owned and reproduce it exactly across JavaScript and Python packages.
Release jobs publish the generated workspace inventory in dependency-safe
workflow order without introducing another version owner.

<!-- cli-reference:start -->

## Command reference

### `release`

Prepare an annotated release and select its build and publication steps

```sh
release [options]
```

#### Options

| Option                                 | Description                                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--root <value>`                       | Repository or workspace root (env: PROJEN_RELEASE_ROOT)                                                                                                           |
| `--branch <value>`                     | Release branch (default: "main", env: PROJEN_RELEASE_BRANCH)                                                                                                      |
| `--prefix <value>`                     | Release tag prefix (default: "v", env: PROJEN_RELEASE_PREFIX)                                                                                                     |
| `--remote <value>`                     | Git remote (default: "origin", env: PROJEN_RELEASE_REMOTE)                                                                                                        |
| `--python-root <value>`                | Python package root for local publish (default: "packages/py", env: PROJEN_RELEASE_PYTHON_ROOT)                                                                   |
| `--validate <value>`                   | Repeatable task to run before pushing (default: [], env: PROJEN_RELEASE_VALIDATE)                                                                                 |
| `--bump`                               | Create and synchronize a patch bump; disable only for an existing committed bump (default: true, env: PROJEN_RELEASE_BUMP)                                        |
| `--no-bump`                            | Disable create and synchronize a patch bump; disable only for an existing committed bump                                                                          |
| `--publish <value>`                    | Publication scope (choices: "auto", "npm", "pypi", "local", "none", default: "auto", env: PROJEN_RELEASE_PUBLISH)                                                 |
| `-i, --install <value>`                | Dependency install mode: auto follows manifests, always installs, never reuses (choices: "auto", "always", "never", default: "auto", env: PROJEN_RELEASE_INSTALL) |
| `-n, --npm`                            | Build and publish npm packages (default: true, env: PROJEN_RELEASE_NPM)                                                                                           |
| `--no-npm`                             | Disable build and publish npm packages                                                                                                                            |
| `--pypi`                               | Build and publish Python packages (default: true, env: PROJEN_RELEASE_PYPI)                                                                                       |
| `--no-pypi`                            | Disable build and publish python packages                                                                                                                         |
| `--docs`                               | Build and deploy documentation (env: PROJEN_RELEASE_DOCS)                                                                                                         |
| `--no-docs`                            | Disable build and deploy documentation                                                                                                                            |
| `--validation`                         | Run optional release validation tasks before publishing (default: true, env: PROJEN_RELEASE_VALIDATION)                                                           |
| `--no-validation`                      | Disable run optional release validation tasks before publishing                                                                                                   |
| `-w, --watch-github-actions`           | Wait for and log the tag-triggered GitHub Actions release (default: true, env: PROJEN_RELEASE_WATCH_GITHUB_ACTIONS)                                               |
| `--no-watch-github-actions`            | Disable wait for and log the tag-triggered github actions release                                                                                                 |
| `--release-notes`                      | Generate and commit release notes for a new version bump (default: true, env: PROJEN_RELEASE_RELEASE_NOTES)                                                       |
| `--no-release-notes`                   | Disable generate and commit release notes for a new version bump                                                                                                  |
| `--release-notes-text <value>`         | Write supplied release-note Markdown without invoking Genie (env: PROJEN_RELEASE_RELEASE_NOTES_TEXT)                                                              |
| `--release-notes-file <value>`         | Copy release-note Markdown from this file without invoking Genie (env: PROJEN_RELEASE_RELEASE_NOTES_FILE)                                                         |
| `--release-notes-instructions <value>` | Append instructions to the Genie release-note prompt (env: PROJEN_RELEASE_RELEASE_NOTES_INSTRUCTIONS)                                                             |
| `--demo-deploy`                        | Run the local-only AppKit demo deployment after tagging and publication (env: PROJEN_RELEASE_DEMO_DEPLOY)                                                         |
| `--no-demo-deploy`                     | Disable run the local-only appkit demo deployment after tagging and publication                                                                                   |
| `--profile <value>`                    | Optional Databricks CLI profile passed to the demo deployment (env: PROJEN_RELEASE_PROFILE)                                                                       |
| `--local-publish`                      | Publish to configured local registries (default: true, env: PROJEN_RELEASE_LOCAL_PUBLISH)                                                                         |
| `--no-local-publish`                   | Disable publish to configured local registries                                                                                                                    |
| `--local-registry <value>`             | Local npm registry selection: auto, false, or URL (default: "auto", env: PROJEN_RELEASE_LOCAL_REGISTRY)                                                           |
| `--local-pypi <value>`                 | Local devpi registry selection: auto, false, or URL (default: "auto", env: PROJEN_RELEASE_LOCAL_PYPI)                                                             |

<!-- cli-reference:end -->
