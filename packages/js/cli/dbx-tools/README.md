# @dbx-tools/cli

The single `dbx` CLI: workspace lifecycle, Model Serving proxy, and AppKit env.

This package installs one command, `dbx` (aliased `dbx-tools`), with three
groups:

| Command           | What it does                                                             |
| ----------------- | ------------------------------------------------------------------------ |
| `dbx dev`         | Bootstrap or repair a dbx-tools workspace, then forward to projen.       |
| `dbx model-proxy` | Local OpenAI-compatible proxy in front of Databricks Model Serving.      |
| `dbx appkit env`  | Print the environment an AppKit app resolves, as eval-able shell output. |

Key features:

- One installed command for every dbx-tools CLI surface, so there is a single
  thing to install and a single `--help` to discover.
- Bootstrap path that scaffolds bun/projen into an empty or partially-set-up
  folder, including the initial install and synth.
- Toolchain repair for a cloned repo whose generated files and `node_modules`
  are gitignored.
- Transparent forwarding to projen for any task once the workspace is ready.
- Custom-registry forcing that survives bun's own resolution rules, applied only
  when the effective registry is not npmjs.
- Importable CLI/root/bun helpers for tests and thin wrapper commands.

`model-proxy` and `appkit` live in
[`@dbx-tools/cli-model-proxy`](../model-proxy) and
[`@dbx-tools/cli-appkit-env`](../appkit-env) and are imported LAZILY, only once
their name is matched - so `dbx dev` never pays to load the Databricks SDK or
AppKit. Run `dbx <group> --help` for a group's own flags; each forwards `--help`
to the child program rather than answering it at the root.

## Bootstrap A Workspace

```sh
dbx dev sync
```

In an empty folder this creates the minimum bun/projen structure needed for
`@dbx-tools/projen`, installs the toolchain, and runs the first synth. In a
freshly cloned repo it seeds the missing toolchain and synthesizes. This is the
case projen cannot handle on its own, because there are no tasks to run yet.

The three cases `dbx dev` dispatches on, in order:

| Workspace state                           | What happens                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `.projenrc.ts`                         | Full bootstrap: scaffold, install, initial synth.                                                                                                     |
| `.projenrc.ts` but no installed toolchain | Seed the toolchain, run the initial synth, then install. Task args are not forwarded, because the tasks they name do not exist until the first synth. |
| Established workspace                     | Ensure deps, bring the engine up to this CLI's version, forward the args to projen.                                                                   |

Everything after `dev` is forwarded verbatim, flags included - `dbx dev sync
--watch` runs the `sync` task with `--watch`. `dev` is an explicit subcommand
rather than the bare root action so a projen task name can never collide with a
sibling command group.

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

`dbx dev <task>` still works and forwards to the same projen task, but the
`bun run` form is the documented one for an established workspace.

## Proxy Model Serving And Resolve AppKit Env

```sh
dbx model-proxy --profile my-workspace --port 4000
eval "$(dbx appkit env --quiet)"
```

See [`@dbx-tools/cli-model-proxy`](../model-proxy) and
[`@dbx-tools/cli-appkit-env`](../appkit-env) for the full flag surface, auth
resolution, and output formats.

## Use The CLI Internals

```ts
import { cli, root, bun } from "@dbx-tools/cli";

await cli.prepareAndRunProjen(["sync"]);
const workspaceRoot = await root.findWorkspaceRoot();
bun.runProjen(["barrels"], workspaceRoot);
```

Importing internals is mainly useful for tests or wrapper scripts; most users
should run the `dbx` bin.

## Modules

- `cli` - the root commander program (`buildProgram()`, `runCli()`) and the
  `dev` implementation `prepareAndRunProjen()`.
- `bootstrap` - empty-workspace bootstrap, toolchain seeding, and the initial synth.
- `root` - workspace-root detection and bootstrap/install checks.
- `bun` - bun discovery, workspace install, registry forcing, and projen delegation.

The reusable project classes and generators live in
[`@dbx-tools/projen`](../../../projen).
