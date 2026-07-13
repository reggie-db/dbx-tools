# @dbx-tools/cli

A [projen](https://projen.io)-driven **pnpm monorepo generator**. Exports the
`DBXToolsNodeProject` / `DBXToolsTypeScriptProject` project subclasses and ships
the `dbxtools` CLI. Drop a `src`-bearing folder under `workspaces/<tag>/<name>`
and it is configured, type-checked, and barrelled automatically - or bootstrap a
brand-new empty folder from nothing with `dbxtools sync`.

## Install

```sh
pnpm add -D @dbx-tools/cli projen typescript tsx
```

## Usage

```ts
// .projenrc.ts
import { DBXToolsNodeProject, packageMixin } from "@dbx-tools/cli";

const project = new DBXToolsNodeProject();

// Per-package tweaks are constructs mixins, applied across the subtree after the
// built-in tag mixins the root already applied during construction.
project.with(
  packageMixin(
    (p) => p.dbxToolsConfig.tags.includes("ui"),
    (p) => p.addDeps("@dbx-tools/shared-core@workspace:*"),
  ),
);
project.synth();
```

Then `pnpm exec projen` to synthesize, or `pnpm dbxtools sync --watch` to keep
the tree in sync while editing.

## CLI

```sh
dbxtools sync [--watch]   # bootstrap/re-synth the workspace; --watch keeps it in sync
dbxtools barrels          # rebuild every package's root index.ts barrel
dbxtools openapi          # generate openapi packages from tsoa controllers
dbxtools clean [-y]       # remove generated files + node_modules (interactive picker)
```

See the [repository README and AGENTS.md](https://github.com/reggie-db/dbx-tools)
for the full model (tags, mixins, discovery, and the generated file contract).
