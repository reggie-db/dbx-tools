# dbx-tools

CLI package for the dbx-tools projen workspace engine.

Run the `dbxtools` command to bootstrap a repo, synthesize generated files,
rebuild barrels, generate OpenAPI clients, or clean generated output. Import the
package modules when custom tooling needs the same root detection, pnpm
delegation, or CLI program behavior.

Key features:

- `sync` bootstrap path for empty folders plus normal projen synthesis for
  existing workspaces.
- Focused `--watch` loop for projenrc changes, barrel generation, and OpenAPI
  generation.
- Standalone barrel and OpenAPI commands for post-synth workflows.
- Generated-file cleanup with an interactive or non-interactive mode.
- Importable CLI/root/pnpm helpers for tests and thin wrapper commands.

## Bootstrap Or Sync A Workspace

```sh
dbxtools sync
dbxtools sync --watch
```

In an empty folder, `sync` creates the minimum pnpm/projen structure needed for
`@dbx-tools/projen`. In an existing workspace, it runs projen and the post-synth
generators. `--watch` starts focused watchers for structural changes, barrels,
and OpenAPI generation.

## Generate Barrels And OpenAPI Clients

```sh
dbxtools barrels
dbxtools openapi
```

`barrels` rebuilds package-root `index.ts` files from exported modules under
`src/`. `openapi` scans tsoa controllers and writes generated OpenAPI packages.

## Clean Generated Output

```sh
dbxtools clean
dbxtools clean -y
```

`clean` removes generated read-only files and can also remove install output. Use
it before debugging synthesis drift or validating that the repo can regenerate
from source.

## Use The CLI Internals

```ts
import { cli, root, pnpm } from "dbx-tools";

await cli.runCli(["sync"]);
const workspaceRoot = await root.findWorkspaceRoot();
pnpm.runProjen(["barrels"], workspaceRoot);
```

Importing internals is mainly useful for tests or wrapper scripts; most users
should run the `dbxtools` bin.

## Modules

- `cli` - Commander entrypoint and `runCli()`.
- `bootstrap` - empty-workspace bootstrap.
- `root` - workspace-root detection and bootstrap/install checks.
- `pnpm` - pnpm/projen command resolution and delegation.

The reusable project classes and generators live in
[`@dbx-tools/projen`](../../../projen).
