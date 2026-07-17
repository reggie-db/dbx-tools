# @dbx-tools/projen

Projen engine for dbx-tools pnpm workspaces.

Import this package from `.projenrc.ts` when a repository should discover
workspace packages from the filesystem and generate manifests, tsconfigs,
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
import { project as projectApi } from "@dbx-tools/projen";

const project = new projectApi.DBXToolsNodeProject({
  name: "my-apps",
  scope: "my-apps",
  workspacePackageRoots: ["workspaces", "examples"],
});

project.synth();
```

Every `src`-bearing folder under the configured roots becomes a
`DBXToolsTypeScriptProject`. Folder path drives package name and runtime tags.

The engine treats generated barrels, tests, declaration files, and folders
without exported source modules as implementation details. They do not create
new package membership.

## Customize Packages With Mixins

```ts
import { mixin, project as projectApi, projectPredicate } from "@dbx-tools/projen";

const project = new projectApi.DBXToolsNodeProject();

project.with(
  mixin.mixin(projectPredicate.hasTag("shared"), (pkg) => {
    pkg.addDeps("zod@catalog:");
  }),
);

project.synth();
```

Built-in tag mixins set runtime defaults for `shared`, `node`, `cli`, `server`,
`ui`, and `openapi`. Repo-specific mixins layer package-specific dependencies,
scripts, and generated files on top.

## Work With Package Discovery

```ts
import { workspace } from "@dbx-tools/projen";

const discovered = workspace.scanPackages(process.cwd(), ["workspaces"]);
const recorded = workspace.workspacePackages();
```

`scanPackages()` reads the filesystem during synth. `workspacePackages()` reads
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
schema modules. `generateBarrels()` writes package-root `index.ts` barrels with
module namespaces and flat unique type exports.

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

`pnpmWorkspace.DBXToolsPNPMWorkspace` owns `pnpm-workspace.yaml`, package
members, catalog entries, overrides, and build-script allowlists.

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
- `workspace` - filesystem discovery and recorded package metadata.
- `pnpmWorkspace` - generated pnpm workspace file and catalog model.
- `barrels` / `moduleExports` - public entrypoint generation.
- `codegen` - `.d.ts` to zod schema generation.
- `openapi` - tsoa/OpenAPI package generation.
- `vite` / `tsconfig` / `vscode` - generated support files/components.
- `generated` / `clean` / `watch` / `scaffold` - read-only file stamping,
  cleanup, watchers, and synth orchestration.
- `publish` - packaging and tag-based release helpers.
- `engineRoot` - engine package root resolution for bootstrapped repos.

The user-facing CLI is [`dbx-tools`](../../cli/dbx-tools).
