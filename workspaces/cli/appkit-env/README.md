# @dbx-tools/appkit-env

CLI and formatting helpers for exporting AppKit auto-configuration results.

Use the `appkit-env` bin when a shell or process manager needs the Lakebase /
AppKit environment that [`@dbx-tools/node-appkit`](../../node/appkit) would
resolve before `createApp()`.

Key features:

- Runs the same AppKit auto-configuration path used by
  [`@dbx-tools/node-appkit`](../../node/appkit).
- Emits only variables that changed during auto-configuration.
- Supports shell `export`, JSON, and Windows `set` output formats.
- Provides importable env snapshot/diff/format helpers for tests and wrapper
  CLIs.
- Keeps local shell setup aligned with deployed AppKit startup behavior.

## Load Env Into A Shell

```sh
eval "$(appkit-env --quiet)"
```

The command snapshots `process.env`, runs AppKit auto-config, diffs the result,
and prints only new or changed variables. On POSIX shells the default output is
`export KEY=value`.

This is useful when another process must start after Lakebase discovery has
filled `PGHOST`, `PGDATABASE`, `PGUSER`, or related AppKit variables.

## Inspect JSON Or Windows Output

```sh
appkit-env --format json
appkit-env --format windows
```

Use JSON for process managers and tests. Use Windows format for `cmd.exe`
`set KEY=value` lines.

## Format Env Diffs Programmatically

```ts
import { envExport } from "@dbx-tools/appkit-env";

const before = envExport.snapshotEnv();
process.env.PGHOST = "ep-foo.database.azuredatabricks.net";
const diff = envExport.diffEnv(before);

console.log(envExport.formatEnvExport(diff, "export"));
```

These helpers are useful in tests for auto-config behavior or in custom CLIs
that want the same output formats without invoking the bin.

## Modules

- `envExport` - env snapshots, env diffs, default format detection,
  `formatEnvExport()`, and `parseEnvExportFormat()`.

Auto-config itself lives in
[`@dbx-tools/node-appkit`](../../node/appkit).
