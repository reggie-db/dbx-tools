# `@dbx-tools/cli-auth`

Databricks browser OAuth commands mounted under `dbx auth`.

The package uses the generated [`@dbx-tools/auth-u2m`](../../node/auth-u2m)
bindings for profile resolution, browser authorization, token refresh, locking,
and credential storage.

Key features:

- browser login for workspace, account, and unified OAuth targets;
- secure keyring storage by default, with file, memory, and Postgres options;
- access-token lookup, optional login, and forced refresh;
- profile and host resolution compatible with Databricks configuration;
- JSON output that excludes refresh credentials;
- one `dbx` installation, with native auth code loaded only for `dbx auth`.

## Commands

```sh
dbx auth login --profile DEFAULT
dbx auth token --profile DEFAULT
dbx auth token --profile DEFAULT --login-if-missing
dbx auth token --profile DEFAULT --force-refresh
dbx auth status --profile DEFAULT
dbx auth logout --profile DEFAULT
```

`login` and `token` write access-token JSON to stdout. `status` writes the
resolved profile, host, and storage name. `logout` produces no output when it
succeeds.

## Common options

- `--profile <name>` selects a Databricks CLI profile.
- `--host <url>` selects a workspace or accounts host.
- `--account-id <id>` and `--workspace-id <id>` provide target identifiers.
- `--config-file <path>` selects the Databricks configuration file.
- `--client-id <id>` selects the OAuth client.
- `--scopes <scopes>` accepts a comma-separated value and may be repeated.
- `--target workspace|account|unified` selects the OAuth target.
- `--storage auto|memory|file|keyring|postgres` selects credential storage.
- `--cache-dir <path>` selects the file-storage directory.
- `--callback-image-src <src>` sets the callback logo URL or data URI.
- `--postgres-url <url>` supplies the Postgres storage connection.
- `--lock-timeout-seconds`, `--login-timeout-seconds`, and
  `--refresh-buffer-seconds` control auth timing.

The Databricks options also read their standard `DATABRICKS_*` environment
variables. U2M storage and timeout options read the matching
`DBX_TOOLS_U2M_*` variables shown by `dbx auth --help`.

## Postgres storage

```sh
dbx auth \
  --profile DEFAULT \
  --storage postgres \
  --postgres-url postgresql://localhost/auth \
  token
```

The CLI creates a `pg.Pool`, passes it to
`@dbx-tools/auth-u2m`'s `postgres.createStorage`, and closes the pool after the
command. The database role needs permission to create and modify the
`dbx_tools_auth_u2m_tokens` table and use advisory locks.

## Package use

This package ships no bin. [`@dbx-tools/cli`](../dbx-tools) imports
`buildProgram()` lazily and mounts it as `dbx auth`.

```ts
import { cli } from "@dbx-tools/cli-auth";

await cli.buildProgram().parseAsync(["status"], { from: "user" });
```

Applications that need programmatic OAuth should import
[`@dbx-tools/auth-u2m`](../../node/auth-u2m) directly.

## Modules

- `cli` - Commander program, option translation, command routing, and JSON
  output.

# replace this
