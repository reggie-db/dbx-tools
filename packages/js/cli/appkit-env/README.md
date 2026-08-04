# @dbx-tools/cli-appkit-env

CLI and formatting helpers for exporting AppKit auto-configuration results.

Use `dbx appkit env` when a shell or process manager needs the Lakebase /
AppKit environment that [`@dbx-tools/appkit`](../../node/appkit) would
resolve before `createApp()`.

Key features:

- Runs the same AppKit auto-configuration path used by
  [`@dbx-tools/appkit`](../../node/appkit).
- Emits only variables that changed during auto-configuration.
- Supports shell `export`, JSON, and Windows `set` output formats.
- Provides importable env snapshot/diff/format helpers for tests and wrapper
  CLIs.
- Keeps local shell setup aligned with deployed AppKit startup behavior.

## Load Env Into A Shell

```sh
eval "$(dbx appkit env --quiet)"
```

The command snapshots `process.env`, runs AppKit auto-config, diffs the result,
and prints only new or changed variables. On POSIX shells the default output is
`export KEY=value`.

This package ships no bin of its own. It contributes the `appkit` command group
to the single `dbx` CLI in [`@dbx-tools/cli`](../dbx-tools), which is what you
install:

```sh
npm install --global @dbx-tools/cli
dbx appkit env --quiet
```

`dbx` imports this package lazily, so AppKit loads only when an `appkit`
command actually runs.

This is useful when another process must start after Lakebase discovery has
filled `PGHOST`, `PGDATABASE`, `PGUSER`, or related AppKit variables.

## Inspect JSON Or Windows Output

```sh
dbx appkit env --format json
dbx appkit env --format windows
```

Use JSON for process managers and tests. Use Windows format for `cmd.exe`
`set KEY=value` lines.

## Format Env Diffs Programmatically

```ts
import { envExport } from "@dbx-tools/cli-appkit-env";

const before = envExport.snapshotEnv();
process.env.PGHOST = "ep-foo.database.azuredatabricks.net";
const diff = envExport.diffEnv(before);

console.log(envExport.formatEnvExport(diff, "export"));
```

These helpers are useful in tests for auto-config behavior or in custom CLIs
that want the same output formats without invoking the bin.

## Modules

- `cli` - the `dbx appkit` commander program: `buildProgram(name?)` (what
  `@dbx-tools/cli` mounts), `buildEnvCommand()`, and `runCli()`.
- `envExport` - env snapshots, env diffs, default format detection,
  `formatEnvExport()`, and `parseEnvExportFormat()`.

Auto-config itself lives in
[`@dbx-tools/appkit`](../../node/appkit).
