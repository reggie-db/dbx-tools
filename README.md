# dbx-tools

`dbx-tools` is a projen-driven pnpm monorepo generator for TypeScript
workspaces. It is both the tool and a dogfood repository for the tool:

- `workspaces/shared/projen` implements the generator engine.
- `workspaces/cli/dbx-tools` publishes the `dbxtools` command.
- the rest of `workspaces/` are real shared packages consumed by the engine and
  examples.
- `example-workspaces/` contains seed projects that exercise UI, server, CLI,
  OpenAPI, AppKit, Mastra, and shared-package behavior.

The main value is that package membership and runtime configuration are inferred
from the filesystem. Create a folder with source under `workspaces/`, run sync,
and dbx-tools creates the pnpm workspace member, package manifest, tsconfig,
barrel exports, common tasks, and environment-specific dependencies.

## What the code does

At a high level, `new DBXToolsNodeProject()` builds a projen `NodeProject` root
that scans workspace roots for package folders. Each discovered package becomes a
`DBXToolsTypeScriptProject` child, and projen synthesizes the generated files.

The important implementation files are:

| File                                                | Role                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `workspaces/shared/projen/src/project.ts`           | Defines `DBXToolsNodeProject`, `DBXToolsTypeScriptProject`, naming, default projen options, root setup, and package construction. |
| `workspaces/shared/projen/src/workspace.ts`         | Scans `workspaces/` and reads `pnpm-workspace.yaml`; this is the discovery layer.                                                 |
| `workspaces/shared/projen/src/tags.ts`              | Maps tags like `ui`, `server`, `cli`, `shared`, `node`, and `openapi` to dependencies, tsconfig settings, and tasks.              |
| `workspaces/shared/projen/src/mixin.ts`             | Converts predicates plus callbacks into constructs-native mixins.                                                                 |
| `workspaces/shared/projen/src/project-predicate.ts` | Provides package predicates such as `hasName`, `hasTag`, and `hasPath`.                                                           |
| `workspaces/shared/projen/src/pnpm-workspace.ts`    | Emits the root `pnpm-workspace.yaml`, catalog, build allowances, and overrides.                                                   |
| `workspaces/shared/projen/src/barrels.ts`           | Generates package-root `index.ts` barrels from exported modules under `src/`.                                                     |
| `workspaces/shared/projen/src/openapi.ts`           | Generates typed OpenAPI client packages from `tsoa` controllers.                                                                  |
| `workspaces/shared/projen/src/scaffold.ts`          | Decides when watch mode needs a full re-synth and runs `.projenrc.ts`.                                                            |
| `workspaces/cli/dbx-tools/src/cli.ts`               | Implements the `dbxtools` command surface.                                                                                        |

## Workspace discovery

A workspace package is any folder under a configured workspace root that owns a
`src/` directory containing module files. The default root is `workspaces`; this
repo also scans `example-workspaces`.

Discovery is intentionally structural:

```text
workspaces/shared/core/src/value.ts      -> package: workspaces/shared/core
workspaces/cli/dbx-tools/src/cli.ts      -> package: workspaces/cli/dbx-tools
example-workspaces/ui/app/src/App.tsx    -> package: example-workspaces/ui/app
```

`workspace.ts` scans for module files under `src/`, finds the folder that owns
that `src/`, and returns a `DiscoveredPackage`. The package's path under the
workspace root drives both its npm name and its tag candidates.

Generated files such as package-root `index.ts` barrels, `.d.ts` files, tests,
and files without exports do not create package membership.

## Tags, runtimes, and enforcement

Tags describe runtime environment, not npm scope. A package can carry multiple
tags. Tags are written into `package.json` under `dbxToolsConfig.tags`, and the
tag list is the source used by post-synth commands.

Tag candidates are derived from the folder path. For example:

```text
workspaces/ui/app        -> tag candidates: ui
workspaces/shared/model  -> tag candidates: shared
workspaces/cli/dbx-tools -> tag candidates: cli
```

The built-in tag mixins in `tags.ts` apply concrete behavior:

| Tag       | Runtime                       | Main effects                                                                      |
| --------- | ----------------------------- | --------------------------------------------------------------------------------- |
| `ui`      | Browser, React, Vite          | Adds React/Vite deps, DOM libs, JSX, `vite.config.ts`, `dev/build/preview` tasks. |
| `server`  | Node service                  | Adds Express/tsoa deps, Node types, decorator support, `dev/start` tasks.         |
| `cli`     | Node CLI                      | Adds commander and Clack deps, Node types.                                        |
| `node`    | Plain Node                    | Adds Node types and Node compiler settings.                                       |
| `shared`  | Runtime-agnostic TypeScript   | Uses ES2022 libs with no DOM and no Node globals.                                 |
| `openapi` | Browser-safe generated client | Adds `openapi-fetch` and DOM libs.                                                |

This is enforced through generated `tsconfig.json` files. A shared package should
not accidentally depend on `document` or `process`; a UI package should not pick
up Node globals unless it is intentionally tagged otherwise.

## Naming model

`PackageIdentifier` in `project.ts` normalizes folder paths into npm package
names. The first segment is the npm scope, and remaining path segments become
the package name.

In this repo, `.projenrc.ts` sets the scope to `dbx-tools`, so examples include:

```text
workspaces/shared/core      -> @dbx-tools/shared-core
workspaces/shared/projen    -> @dbx-tools/projen     # overridden in .projenrc.ts
workspaces/cli/dbx-tools    -> dbx-tools             # published CLI package
workspaces/shared/model     -> @dbx-tools/shared-model
```

The distinction matters:

- scope means the npm `@scope`.
- tag means runtime category such as `shared`, `cli`, or `ui`.

Do not use "scope" when referring to tags.

## Package map

Current real packages under `workspaces/`:

| Package                       | Path                          | Purpose                                                                                                                                                      |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dbx-tools`                   | `workspaces/cli/dbx-tools`    | Published CLI. It exposes `dbxtools`, bootstraps empty folders, and forwards workspace operations.                                                           |
| `@dbx-tools/projen`           | `workspaces/shared/projen`    | Generator engine. Exports the project classes, mixin helpers, workspace scanning, barrel generation, OpenAPI generation, watch support, and publish helpers. |
| `@dbx-tools/shared-core`      | `workspaces/shared/core`      | Dependency-light utilities for async control, equality, errors, subprocess execution, hashing, predicates, strings, values, and project paths.               |
| `@dbx-tools/shared-file-scan` | `workspaces/shared/file-scan` | File discovery and watching helpers built on glob, minimatch, and chokidar with shared ignore behavior.                                                      |
| `@dbx-tools/shared-model`     | `workspaces/shared/model`     | Databricks model endpoint taxonomy, zod schemas, endpoint classification, and request/response wire contracts.                                               |

The example packages are generated and managed the same way as real packages,
but they live under `example-workspaces/` so they do not hide the production
engine packages.

## Generated files

Most package metadata is generated by projen. Edit `.projenrc.ts`, the source
under `workspaces/**/src`, or the generator code. Do not hand-edit generated
files such as:

- `package.json`
- `pnpm-workspace.yaml`
- `tsconfig.json`
- `tsconfig.dev.json`
- package-root `index.ts` barrels
- generated OpenAPI clients
- generated `vite.config.ts`

Generated files are stamped and often made read-only. The right fix is normally
to change a mixin, package source, or projen definition and then re-synth.

## Barrels

`dbxtools barrels` rebuilds package-root `index.ts` files.

The barrel generator:

- scans each package's `src/`;
- skips tests, declarations, generated barrels, and private `_` paths;
- parses modules and only exports files that contain top-level exports;
- emits namespace exports such as `export * as value from "./src/value";`;
- supports a hand-authored `exports.ts` override next to the generated barrel.

This makes each package's public entrypoint stable while keeping source modules
free to stay organized under `src/`.

## OpenAPI generation

`dbxtools openapi` scans `server` and `node` packages for modules that import
`tsoa`. For each package with controllers, it generates an `openapi/<name>`
package containing:

- `openapi.json`
- `src/schema.ts` from `openapi-typescript`
- `src/client.ts` using `openapi-fetch`

The source of truth remains the controller decorators and TypeScript types. The
generated client is intended to be browser-safe.

## Mixins

Per-package customization is done with constructs mixins:

```ts
import { mixin, project as projectApi, projectPredicate } from "@dbx-tools/projen";

const project = new projectApi.DBXToolsNodeProject();

project.with(
  mixin.mixin(
    projectPredicate
      .hasPath("workspaces")
      .and(projectPredicate.hasName("*/shared-model"))
      .and(projectPredicate.hasTag("shared")),
    (pkg) => {
      pkg.addDeps("zod@catalog:");
    },
  ),
);

project.synth();
```

The root applies built-in tag mixins during construction. Consumer mixins applied
after construction layer on top of those defaults.

## Commands

Install and synthesize:

```sh
pnpm install
pnpm exec projen
```

Everyday commands:

```sh
pnpm dbxtools sync             # bootstrap or re-synth once
pnpm dbxtools sync --watch     # re-synth/watch loop for active development
pnpm dbxtools barrels          # rebuild package entrypoint barrels
pnpm dbxtools openapi          # generate typed OpenAPI packages
pnpm dbxtools clean            # remove generated files interactively
pnpm -r compile                # type-check all workspace packages
pnpm test                      # run configured tests
```

Root package scripts forward through projen, so these are also available:

```sh
pnpm build
pnpm compile
pnpm eslint
pnpm format
pnpm release
```

## Watch model

The watch path is deliberately more focused than stock `projen --watch`.

`dbxtools sync --watch` runs one initial synth, then starts watchers for:

- `.projenrc.ts` and configured resynth paths, which trigger a full re-synth;
- source files, which trigger targeted barrel rebuilds;
- `tsoa` controller files, which trigger OpenAPI regeneration.

`scaffold.ts` compares the package set on disk with the package set recorded in
`pnpm-workspace.yaml`. If the set changed, a full re-synth is required. If only
source content changed, targeted work is enough.

## Bootstrapping another repo

Once published or linked locally, an empty folder can be initialized with:

```sh
mkdir my-workspace
cd my-workspace
pnpm dlx dbxtools sync
```

The bootstrap path creates the minimum project structure needed for projen and
dbx-tools to manage the workspace. It does not create sample application code.
After that, add source folders under `workspaces/` and run sync again.

## Development notes

- The generated workspace list in `pnpm-workspace.yaml` is the source of truth
  for post-synth commands.
- Add runtime behavior by adding or changing tag mixins in `tags.ts`.
- Add package-specific behavior with mixins in `.projenrc.ts`.
- Keep real packages in `workspaces/`; keep demonstrators in `example-workspaces/`.
- Prefer changing source or projen definitions over editing generated output.
- If a new package does not appear, make sure it has a real module file under
  `src/` and then run `pnpm dbxtools sync`.

## Current status

The current branch is focused on folding shared JavaScript helper code into the
TypeScript workspace packages, especially `shared-core` and `shared-model`.
The repository is structured so these shared packages can become the common base
for the generator, CLI, and downstream Databricks-oriented tools.
