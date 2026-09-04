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
Every generated TOML file is parsed and reserialized with `smol-toml`, so nested
tables and arrays use consistent formatting instead of projen's indented table
headers.

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
automatically wires matching private Node and Python binding packages using the
same capability name. Repository-specific dependencies and features remain
declarative options in `.projenrc.ts`; generated bindings are built separately
from projen synthesis. Node facades compile to `lib/` and publish JavaScript
entry points that plain Node can load from `node_modules`. Use a crate's
`nodeExports` option for hand-authored Node subpaths beside the generated
bindings.

`sync --watch` runs a focused Rust watcher beside the OpenAPI watcher. Changes
inside an existing UniFFI crate regenerate only that crate's bindings; adding or
removing a crate or `setup_scaffolding!()` marker triggers a full synth. Repos
without Rust crates start no Rust watcher. When Rust projects are detected,
Cargo is required and the focused task fails immediately if it is unavailable.

The workspace also generates a `rust-release` workflow from discovered crates,
UniFFI bindings, and release-enabled binaries. The root `release-dispatch`
workflow resolves the annotated release tag and sends the tag plus commit SHA to
`rust-release` when Rust is present. The Rust workflow runs in the configured release
branch cache scope, checks out the supplied SHA, fetches the tag, and requires
both the tag target and `HEAD` to equal that SHA before building. Its matrix has
one row per target. Each row installs native dependencies and restores
Cargo/sccache once,
builds the Rust workspace once, then packages every discovered output from that
shared build. Bun and the workspace install are present only when a Node binding
needs TypeScript generation; uv is present only when a Python wheel is needed.
A new dispatch cancels queued and in-progress release and docs workflows before
starting, and each workflow's concurrency group also cancels its previous run.
A binary-only workspace therefore installs neither. `rustVersion` remains the
MSRV recorded in package manifests, while `releaseRustVersion` independently
defaults release compilation to `stable`. UBRN uses that same release toolchain
unless `ubrnRustVersion` explicitly selects another one.

Generated build and release workflows share the Bun cache helpers from
`bun-workflow.ts`. One `BUN_VERSION` value drives setup and cache keys, while a
generated dependency-only fingerprint keeps release version bumps from
invalidating Bun's global package cache. `node_modules` remains uncached.

The final host UBRN executable is cached by pinned UBRN version, Rust toolchain,
runner OS, and runner architecture. A hit skips both the workspace `bun install`
and the UBRN Cargo build. Release packaging passes the cached executable directly
to the Node binding generator and keeps the package barrel copied from source,
so it does not need the installed projen dependency graph. A miss saves the
validated executable immediately, before workspace build and packaging can fail.
Bun runtime setup still runs in the single facade row because the binding
generator is TypeScript; non-facade rows skip the complete Bun/UBRN path.
Stable Windows rows verify and use the hosted runner's installed Rust toolchain
and select `rust-lld` for the workspace build. Cargo registry caches
and the `SCCACHE_GHA_VERSION` namespace stay stable per target/toolchain across
version tags. Cache keys, restore results, sccache statistics, and phase timings
are written to each build log. Python generation executes the already-built
`target/<triple>/release/uniffi-bindgen` directly. Artifact packaging therefore
does no Rust compilation after the main workspace build.

Artifacts identify their crate, target, and type. Download-only publication
jobs publish native npm platform archives before the facade and publish
platform-tagged Python wheels without checkout, Bun, or `bun install`.
Non-private Cargo crates publish from a source-only job with
`cargo publish --no-verify`; GitHub Release uploads likewise consume prebuilt
binary artifacts without reinstalling a toolchain.

Set the repository variable `LOCAL_REPOSITORIES=true` to enable generated
self-hosted publication from the prebuilt artifacts. Configure `LOCAL_NPM_REGISTRY` and
`LOCAL_PYPI_PUBLISH_URL` with their matching `LOCAL_*` credentials. Set
`LOCAL_CARGO_REGISTRY` to a named Cargo registry such as a loopback
[Kellnr](https://kellnr.io/) instance and provide `LOCAL_CARGO_TOKEN`. Public
Cargo crates also publish directly to crates.io
with `CARGO_REGISTRY_TOKEN`. Override `releaseTargets` only when a consumer has
additional native runners; ordinary projects inherit the maintained matrix
automatically. `bun run bump` also accepts repeatable `--os` and `--arch`
selectors; every selected operating system is crossed with every selected
architecture. Omit both filters to regenerate the complete maintained matrix.
`DBX_TOOLS_RELEASE_PLATFORMS` can select the generated matrix without repeating
environment parsing in a consumer.

Private Python binding projects are marked with `[tool.dbx-tools] private =
true`. They stay out of the standard uv/Python release and docs surfaces;
`rust-release` publishes their prebuilt native wheels directly.
After Rust's public artifacts finish, it dispatches the downstream `release`
event. Python, Node, standalone Node, and docs consume that event independently
and start together with the same verified tag and SHA. Without Rust,
`release-dispatch` sends that event immediately. Configure release GitHub
environments to permit the generated release branch; the trusted-publisher
instructions list that branch with the workflow and environment identity PyPI
verifies.

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

The pushed `v*` tag is also the public release boundary. Available workflow
stages form the generated chain Rust -> Python -> Node -> docs: Rust builds and
publishes native artifacts and Cargo crates, Python publishes standard
distributions, Node publishes standard workspace packages, and docs deploys
after publication. A stage with no corresponding outputs is omitted. Ordinary
pushes to `main` publish none of those surfaces.

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
