# @dbx-tools/cli

Bootstrap CLI for the dbx-tools projen workspace engine.

Run the `dbx-tools` command (aliased `dbxt`) to turn a folder that has no
`.projenrc.ts` or toolchain yet into a working dbx-tools workspace. Once that
workspace exists, everything else is a projen task you run with
`pnpm run <task>` - the CLI only forwards to projen from that point on. Import
the package modules when custom tooling needs the same root detection, pnpm
delegation, or CLI program behavior.

Key features:

- Bootstrap path that scaffolds pnpm/projen into an empty or partially-set-up
  folder, including the initial install and synth.
- Toolchain repair for a cloned repo whose generated files and `node_modules`
  are gitignored.
- Transparent forwarding to projen for any task once the workspace is ready.
- Importable CLI/root/pnpm helpers for tests and thin wrapper commands.

## Bootstrap A Workspace

```sh
dbx-tools sync
```

In an empty folder this creates the minimum pnpm/projen structure needed for
`@dbx-tools/projen`, installs the toolchain, and runs the first synth. In a
freshly cloned repo it seeds the missing toolchain and synthesizes. This is the
case projen cannot handle on its own, because there are no tasks to run yet.

## After Bootstrap, Use The Projen Tasks

The engine registers its commands as projen tasks on the workspace root, so run
them directly instead of going through this CLI:

```sh
pnpm run sync            # one-shot full synth
pnpm run sync --watch    # projenrc + barrels + openapi watchers
pnpm run barrels         # rebuild every package-root index.ts barrel
pnpm run openapi         # generate the openapi packages from tsoa controllers
pnpm run clean           # remove generated (read-only) files; -y to skip the picker
```

`dbx-tools <task>` still works and forwards to the same projen task, but the
`pnpm run` form is the documented one for an established workspace.

## Use The CLI Internals

```ts
import { cli, root, pnpm } from "@dbx-tools/cli";

await cli.runCli(["sync"]);
const workspaceRoot = await root.findWorkspaceRoot();
pnpm.runProjen(["barrels"], workspaceRoot);
```

Importing internals is mainly useful for tests or wrapper scripts; most users
should run the `dbx-tools` bin.

## Modules

- `cli` - Commander entrypoint and `runCli()`.
- `bootstrap` - empty-workspace bootstrap.
- `root` - workspace-root detection and bootstrap/install checks.
- `pnpm` - pnpm/projen command resolution and delegation.

The reusable project classes and generators live in
[`@dbx-tools/projen`](../../../projen).
