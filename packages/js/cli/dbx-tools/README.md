# @dbx-tools/cli

Bootstrap CLI for the dbx-tools projen workspace engine.

Run the `dbx-tools` command (aliased `dbx`) to turn a folder that has no
`.projenrc.ts` or toolchain yet into a working dbx-tools workspace. Once that
workspace exists, everything else is a projen task you run with
`bun run <task>` - the CLI only forwards to projen from that point on. Import
the package modules when custom tooling needs the same root detection, bun
delegation, or CLI program behavior.

Key features:

- Bootstrap path that scaffolds bun/projen into an empty or partially-set-up
  folder, including the initial install and synth.
- Toolchain repair for a cloned repo whose generated files and `node_modules`
  are gitignored.
- Transparent forwarding to projen for any task once the workspace is ready.
- Custom-registry forcing that survives bun's own resolution rules, applied only
  when the effective registry is not npmjs.
- Importable CLI/root/bun helpers for tests and thin wrapper commands.

## Bootstrap A Workspace

```sh
dbx-tools sync
```

In an empty folder this creates the minimum bun/projen structure needed for
`@dbx-tools/projen`, installs the toolchain, and runs the first synth. In a
freshly cloned repo it seeds the missing toolchain and synthesizes. This is the
case projen cannot handle on its own, because there are no tasks to run yet.

The three cases the bin dispatches on, in order:

| Workspace state                           | What happens                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `.projenrc.ts`                         | Full bootstrap: scaffold, install, initial synth.                                                                                                     |
| `.projenrc.ts` but no installed toolchain | Seed the toolchain, run the initial synth, then install. Task args are not forwarded, because the tasks they name do not exist until the first synth. |
| Established workspace                     | Ensure deps, bring the engine up to this CLI's version, forward the args to projen.                                                                   |

## After Bootstrap, Use The Projen Tasks

The engine registers its commands as projen tasks on the workspace root, so run
them directly instead of going through this CLI:

```sh
bun run sync             # one-shot full synth
bun run sync -- --watch  # projenrc + barrels + openapi watchers
bun run barrels          # rebuild every package-root index.ts barrel
bun run openapi          # generate the openapi packages from tsoa controllers
bun run clean            # remove generated (read-only) files; -y to skip the picker
```

`dbx-tools <task>` still works and forwards to the same projen task, but the
`bun run` form is the documented one for an established workspace.

## Use The CLI Internals

```ts
import { cli, root, bun } from "@dbx-tools/cli";

await cli.runCli(["sync"]);
const workspaceRoot = await root.findWorkspaceRoot();
bun.runProjen(["barrels"], workspaceRoot);
```

Importing internals is mainly useful for tests or wrapper scripts; most users
should run the `dbx-tools` bin.

## Modules

- `cli` - Commander entrypoint and `runCli()`.
- `bootstrap` - empty-workspace bootstrap, toolchain seeding, and the initial synth.
- `root` - workspace-root detection and bootstrap/install checks.
- `bun` - bun discovery, workspace install, registry forcing, and projen delegation.

The reusable project classes and generators live in
[`@dbx-tools/projen`](../../../projen).
