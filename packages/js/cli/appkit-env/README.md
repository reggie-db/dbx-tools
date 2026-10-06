# @dbx-tools/cli-appkit-env

Export the environment that AppKit resolves so another process can use the same
Lakebase connection and application configuration. Choose shell, JSON, or
Windows output without repeating AppKit discovery in your startup scripts.

## Configure A Shell

Install the [`dbx` CLI](../dbx-tools), then run this from your AppKit project:

```sh
eval "$(dbx appkit env --quiet)"
```

The command runs AppKit auto-configuration and prints only variables that were
added or changed. The default format is POSIX `export KEY=value` statements.
`--quiet` keeps configuration logs out of the output you evaluate.

Use this before starting a process that needs resolved variables such as
`PGHOST`, `PGDATABASE`, or `PGUSER`.

## Inspect Configuration

```sh
dbx appkit env --format json
dbx appkit env --format windows
```

JSON is useful for process managers and scripts. Windows format produces
`set KEY=value` statements for `cmd.exe`. Review output before sharing it:
resolved configuration may contain credentials.

## Format Environment Changes In Code

```ts
import { envExport } from "@dbx-tools/cli-appkit-env";

const before = envExport.snapshotEnv();
process.env.PGHOST = "ep-example.database.cloud.databricks.com";
const changed = envExport.diffEnv(before);
console.log(envExport.formatEnvExport(changed, "export"));
```

Reuse these helpers when a custom CLI or test needs the same formats. For AppKit
application startup itself, use
[`@dbx-tools/appkit`](../../node/appkit) rather than invoking a shell command.

<!-- cli-reference:start -->

## Command Reference

### `dbx appkit`

```text
Usage: dbx appkit [command]

AppKit helpers: resolve the environment an AppKit app would start with.

Commands:
  env [options]  Run AppKit auto-config and print new/changed env vars.
```

### `dbx appkit env`

```text
Usage: dbx appkit env [options]

Run AppKit auto-config and print new/changed env vars.

Options:
  -f, --format <format>  Output: export (POSIX shell), windows (cmd set), or json. Defaults by
                         platform.
  -q, --quiet            Suppress auto-config log output (LOG_LEVEL=error)
```

<!-- cli-reference:end -->
