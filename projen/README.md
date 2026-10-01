# @dbx-tools/projen

Projen engine for Bun-first dbx-tools workspaces.

Import this package from `.projenrc.ts` when a repository should discover
packages from the filesystem and generate manifests, tsconfigs,
barrels, OpenAPI clients, codegen outputs, and release tasks.

Key features:

- Filesystem package discovery: every `src`-bearing folder under configured
  workspace roots becomes a TypeScript package.
- Tag-driven runtime defaults for shared libraries, Node packages, CLIs,
  servers, OpenAPI clients, and React/browser UI packages.
- Generated package manifests, tsconfigs, package-root barrels, Bun app configs,
  VS Code settings, and a committed `pnpm-workspace.yaml` retained for
  Databricks Apps deployment.
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

Use `DBXToolsTypeScriptProject` itself as the root when one package needs the
same Bun workspace, repository, task, and release defaults without a separate
non-compiling root. It preserves Projen's native compiling `tsconfig.json`
instead of creating a second owner. An explicit `outdir` is the workspace root
for naming, Git metadata, package discovery, codegen, and barrels even when the
calling process has a different current directory.

The unified dbx-tools release surface is enabled by default. Set
`releaseMode: "disabled"` to omit its workflow and bump/version/release tasks.
The inherited Projen `release` and `releaseTrigger` options are intentionally
not part of this engine's public options because they create a competing release
workflow.

Repository policy stays in the consuming `.projenrc.ts`:

- `releaseDocs` supplies repository-defined preparation and build steps plus
  the Pages artifact path. The engine adds release checkout, Bun caching,
  artifact upload, and deployment without naming a docs script or output tree.
- `releasePythonRoot` passes the actual Python package root to local release
  preparation. Omit it when the workspace has no standard Python packages.
- `releaseValidationTasks` names repository tasks that must pass in the release
  worktree before Cargo tests, compilation, local publication, or approval.
  Use it for repository-specific guards that also run in release CI.
- `releaseSummary` controls versioned release notes. It defaults to Cursor,
  Codex, Claude fallback order and writes a deterministic Git summary when every
  configured provider is unavailable; pass `false` to disable or provide a
  `providers` array to choose the order/subset.
- `pullRequestTitlePolicy` configures semantic title types and scope policy.
  Omit it or pass `false` to disable the title job.
- `workflowCacheIgnorePaths` excludes generated output trees that may contain
  package manifests from the dependency-only Bun cache key.
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
publication stamping uses parsed TOML, changes versions and sibling
dependencies structurally, and restores the original files byte-for-byte.

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

## Add A Rust Workspace

`DBXToolsRustWorkspace` discovers every source-bearing folder under its
configurable `root` (default `packages/rs`), generates its Cargo manifest, and
derives the crate name and repository from the parent project. A crate containing
`uniffi::setup_scaffolding!()`
automatically wires matching public Node and Python binding packages using the
`<name>-rs` folder suffix. Node packages are named `@<scope>/<name>-rs`;
Python distributions are named `<scope>-<name>-rs` and import generated values
from `<scope>.<name>_rs.bindings`. Binding packages are always dedicated and
never merge generated code into handwritten Node or Python packages.
Repository-specific dependencies and features remain
declarative options in `.projenrc.ts`; generated bindings are built separately
from projen synthesis. Target-independent Node binding TypeScript is committed
and remains generated/read-only, while native libraries stay ignored. Node
facades compile to `lib/` and publish JavaScript entry points that plain Node
can load from `node_modules`. A complete `bindings.ts` / `_bindings.ts` /
`_bindings-ffi.ts` triplet is exported directly from the generated package
barrel. Python keeps `bindings.py` as the generated implementation and leaves
`__init__.py` empty. Node generation fails when direct binding names conflict.
Do not create a `nodeExports` binding subpath or a handwritten type facade.

Each discovered member is a native Projen `Project`, exposed as
`DBXToolsRustProject`. The same class also owns standalone Cargo projects with
the flat object-style options used by the Node and Python project classes:

```ts
import { project as projenProject } from "@dbx-tools/projen";

new projenProject.DBXToolsRustProject({
  name: "my-apps-core",
  outdir: "native/core",
  version: "0.1.0",
  description: "Shared native runtime",
  repository: "https://github.com/example/my-apps",
});
```

The project emits concrete standalone Cargo metadata plus `compile`, `test`,
`package`, `lint`, `format`, and `format:check` tasks. A nested standalone
project declares its own empty Cargo workspace so a surrounding repository
workspace does not absorb it accidentally. The `examples` option emits explicit
Cargo example targets and `required-features`, so an optional code generator is
excluded from ordinary workspace tests until its feature is enabled.
`DBXToolsRustWorkspace` constructs the same class with workspace-owned metadata
and keeps aggregate binding and release coordination.
`DBXToolsRustWorkspaceOptions.private` supplies the default Cargo publication
policy for every discovered crate; a package-level `private` value overrides it.
The positional constructor and nested `RustPackageOptions` compatibility shape
remain deprecated until the next major release.

Rust dependencies between binding-enabled workspace crates become Node
`workspace:*` and Python `internalDependencies` automatically. Python generation
selects the owning crate and supplies `external_packages` imports. UBRN currently
emits every linked component; the generation task discards dependency outputs
and rewrites their imports to the owning package root, including its generated
`uniffiModule` converter table. It never copies a dependency's records or enums.
Foreign callback adapters must first be wrapped in an object created by their
own native library (`createStorageHandle` for auth), because callback registries
are library-local. Release wheels replace sibling Git requirements with matching
native-wheel versions, and dependent publishers wait for their dependencies.
Each crate builds its own `<crate>-uniffi-bindgen` executable so a workspace
build has no colliding binary outputs. Packaging runs that prebuilt executable.
Cargo manifests, target config, and UniFFI config are generated from structured
Projen `TomlFile` objects. Local and release Python generation share one
dependency-free helper for generator arguments, target-specific executable
names, generated headers, empty `__init__.py`, and native-library placement.

`sync --watch` runs a focused Rust watcher beside the OpenAPI watcher. Changes
inside an existing UniFFI crate regenerate that crate and its dependent bindings
in dependency order; adding or
removing a crate or `setup_scaffolding!()` marker triggers a full synth. Repos
without Rust crates start no Rust watcher. When Rust projects are detected,
Cargo is required and the focused task fails immediately if it is unavailable.
`rs:bindings` is explicit rather than part of root `pre-compile`, so ordinary
JavaScript PR builds type-check committed generated bindings without performing
a host Rust build. Regenerate bindings through the focused watcher or explicit
task while changing a UniFFI API. Release preparation runs Cargo workspace tests
without invoking UBRN.

Rust fingerprinting and binary version stamping use the dependency-free Node
helper generated at `.projen/rust-release.mjs`. The implementation ships with
`@dbx-tools/projen`, so consumers do not need a repository-specific helper
crate, a crates.io publication, or an extra Cargo build before release
orchestration can start.

The workspace generates one `release.yml` workflow for every ecosystem. One
root `VERSION` drives every Node, Python, Cargo, native, and GitHub artifact.
`bun run release` prepares one reviewed PR into `main`; it enables automatic
merge by default and accepts `--no-approve` for a human-controlled merge. One
non-cancelling `release` concurrency group serializes publication.

Release generation writes `release.yml` without scanning for or removing other
workflow files. Consumers explicitly delete exact workflow files they no longer
want.

The release workflow accepts stage-specific manual recovery only for the exact
annotated tag and expected SHA. npm retries compare archive content and
repository identity, PyPI uses hash-aware existing-file behavior, Cargo checks
existing versions, and GitHub assets upload to the single repository release.

Set `releaseSyncBranch` when a repository retains a long-lived source branch.
After publication the workflow fast-forwards a branch that is behind, skips a
branch that already contains released `main`, and merges `main` into a diverged
branch when the merge is conflict-free. Missing branches and conflicted merges
are left untouched.

The Rust matrix has one row per target. Each row installs native dependencies,
builds the Cargo workspace once, then packages every discovered output from
that shared build. Set a source-only crate's or
release-enabled binary's `releaseExcludeOs` package option to omit it from
incompatible rows through Cargo `--exclude`. Release binary packaging and
artifact upload are skipped in those rows. UniFFI crates cannot use this option
because every configured target must produce their artifacts.
Set a release binary's `cli` package option and the workspace
`cliRegistryPath` to generate a typed `dbx` command registry from the same
selected targets. The generated entries carry only the archives that the
release matrix publishes, so an excluded operating system fails locally before
any download is attempted. The runtime command uses `@dbx-tools/core`
`bin.ensure`; the core installer itself contains no product registry.
Rust rows prepare native npm
archives and Python wheels; they do not install Bun or UBRN and do not build
Node facades. A binary-only row therefore installs no language package tool.
`rustVersion` remains the MSRV recorded in package manifests, while
`releaseRustVersion` independently defaults release compilation to `stable`.
Stable Windows rows verify and use the hosted runner's installed Rust toolchain
and select `rust-lld` for the workspace build. Rust release rows restore and
update dependency-only Cargo caches in the release branch's cache scope. The
cache key excludes workspace version changes, and manual tag recovery restores
without saving a tag-scoped copy. There is no separate cache workflow or
sccache layer. Phase timings are written to each build log. Python generation executes the already-built
`target/<triple>/release/<crate>-uniffi-bindgen` directly. Artifact packaging therefore
does no Rust compilation after the main workspace build.

Artifacts identify their crate, target, and type. Rust jobs publish non-private
Cargo crates with `cargo publish --no-verify` and upload requested binary assets
to the GitHub release. Rust jobs never publish npm or PyPI packages.

Set `LOCAL_CARGO_REGISTRY` to a named Cargo registry such as a loopback
[Kellnr](https://kellnr.io/) instance and provide `LOCAL_CARGO_TOKEN`. Public
Cargo crates also publish directly to crates.io
with `CARGO_REGISTRY_TOKEN`. Override `releaseTargets` only when a consumer has
additional native runners; ordinary projects inherit the maintained matrix
automatically. `bun run release` also accepts repeatable `--os` and `--arch`
selectors; every selected operating system is crossed with every selected
architecture. Omit both filters to regenerate the complete maintained matrix.
`DBX_TOOLS_RELEASE_PLATFORMS` can select the generated matrix without repeating
environment parsing in a consumer.

Public UniFFI facades are marked with `dbxToolsConfig.uniffi = true` in Node
manifests and `[tool.dbx_tools.config] uniffi = true` in Python manifests. The
Node jobs consume same-run artifacts, publish native archives first with npm
provenance, compile and publish normal workspace packages including the Projen
engine, then build facades from committed generated TypeScript without UBRN and
publish them in binding dependency order. Local Verdaccio publication does not
enable provenance. Set the `UNIFFI_FACADE_SMOKE` repository variable to `true`
to run the optional nonblocking registry install and import check after facade
publication. Python combines same-run platform wheels with standard wheel and
source builds, then publishes each distribution through its own PyPI
trusted-publisher environment. Binding publishers wait for their dependencies.
Trusted-publisher instructions name `release.yml` and the release branch policy.
The docs jobs generate README and TypeScript API content and deploy GitHub Pages
from the same workflow. When a conventional Node binding path already belongs
to a root subproject, Rust mapping reuses that project and adds binding
dependencies and metadata to its existing manifest.

The workspace npm publisher owns compilation for normal release publication. It
selects every publishable package with compiled entry points, invokes one
root-level filtered compile, then packs each package exactly once with lifecycle
scripts disabled. It validates the archive identity, configured access,
integrity, and repository metadata before publishing those same bytes. Local
release preparation passes `--skip-compile` only after its immediately preceding
validation compile and verifies every expected output exists before reuse.
Package `prepack` tasks remain available for standalone publishes without
multiplying `tsc --build` across the monorepo release flow.

## Customize Packages With Mixins

```ts
import { project as projenProject } from "@dbx-tools/projen";

const project = new projenProject.DBXToolsNodeProject();

projenProject.applyToProjects(project, { tags: "shared" }, (pkg) => {
  pkg.addDeps("zod@catalog:");
});

project.synth();
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
`ui`, and `openapi`. Repo-specific mixins layer package-specific dependencies,
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

`generateCodegen()` reads `package.json` `codegen.inputs` and writes generated
schema modules. They are written read-only, and the root ESLint task runs with
`--fix` (which fails on a read-only file), so each generated module is added to
`ignorePatterns` at synth - named individually via `codegen.codegenModulePaths()`,
never as a blanket `<package>/src/**`. A codegen package may hold hand-written
modules beside its generated ones, and those must stay linted.

`generateBarrels()` writes package-root `index.ts` barrels with module
namespaces, flat unique type exports, `PACKAGE_IDENTIFIER`, and
`PACKAGE_VERSION`, returning the number that actually changed. A name two
modules both declare is ambiguous and stays namespace-only —
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
- `releaseCatalog` / `releasePlan` / `releasePlease` - cross-language ownership,
  affected planning, and Release Please graph propagation.
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

| Task                           | What it does                                         |
| ------------------------------ | ---------------------------------------------------- |
| `bun run build`                | synth + workspace compile and tests                  |
| `bun run compile`              | `tsc --build` in each member, in parallel            |
| `bun run test`                 | `eslint` once, then each member's tests              |
| `bun run sync`                 | re-synth (`--watch` to keep synthing)                |
| `bun run barrels`              | regenerate the read-only `index.ts` barrels          |
| `bun run bump`                 | increment `VERSION` and regenerate version surfaces  |
| `bun run version:check`        | verify every generated version against `VERSION`     |
| `bun run release`              | validate, open, and automatically merge a release PR |
| `bun run release --no-approve` | open the release PR without automatic merge          |

`release` commits and pushes pending source work, creates a release worktree,
increments `VERSION`, synthesizes manifests and registries, runs validation and
local publication, writes the release summary, and opens one PR. It enables
automatic merge unless `--no-approve` is supplied. The merged `VERSION` change
starts publication from the exact `main` SHA and creates one `v<version>` tag;
the command waits for that workflow by default. Use `--no-wait` to return after
requesting auto-merge, `--no-validate` to skip repository tests/compile, or
`--no-local-publish` to skip local registry preflight.
Version resolution considers both repository tags and historical
`<component>-v<version>` tags, ensuring a singular release starts above every
component version left by an independent-version migration.
The repository host and owner are derived from the Git remote. If the GitHub CLI
has multiple accounts for that host, release preparation selects the first
authenticated account with write access to the detected repository. Classic
tokens must include the `workflow` scope so the release PR can update the
generated workflow.

The GitHub PR workflow runs the explicit `pr:validate` task through Projen's
public `BuildWorkflow` `buildTask` option. That task runs synth plus the
workspace TypeScript compile rather than the complete root build. Release
preparation has already run Rust tests, workspace type-checking, and local
package preflight before opening the PR. JavaScript behavior tests remain an
explicit developer task.

The generated workflow publishes the complete public workspace at the singular
version. Rust, Python, Node, GitHub asset, and docs stages share the verified tag
and SHA. Documentation generation runs only on this version-triggered workflow.

Members intentionally keep only the tasks that something OTHER than a human
invokes, so there is no second place to run the same thing:

- `compile` / `test` - what the root's `--filter '*'` delegation calls.
- `prepack` - standalone-publish safety that compiles one package before packing
  (27 of 33 members; the workspace release driver compiles them from the root
  and publishes with lifecycle scripts disabled).
- `watch` - a single-package `tsc --build -w`, for narrowing a long
  edit/compile loop to one package.
- `build` / `package` - a complete compile/test/pack lifecycle when invoked in
  one package. Release preparation validates through the root's filtered tasks,
  and publication concurrently uploads archives that were each packed and
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
Projen-owned and reproduce it exactly across JavaScript, Python, Rust, UniFFI
bindings, native package metadata, and runtime binary registries. Package and
artifact discovery still supplies publication order and target inventory; it
does not create independent version ownership.
