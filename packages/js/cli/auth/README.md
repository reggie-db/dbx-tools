# `@dbx-tools/cli-auth`

Databricks OAuth commands mounted under `dbx auth`.

The package uses the generated
[`@dbx-tools/databricks-auth`](../../node/databricks-auth) bindings for profile
resolution, U2M browser authorization, M2M client credentials, token refresh,
locking, and credential storage.

Key features:

- browser login for workspace, account, and unified OAuth targets;
- M2M client-credentials tokens with HTTP Basic client authentication;
- U2M preference by default, with standard M2M resolution available through
  `--no-prefer-user-to-machine`;
- Databricks CLI refresh when available, with native file fallback;
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
succeeds. `token` mints an M2M token when no cached token exists; U2M requires
`login` or `--login-if-missing`.

## Common options

- `--profile <name>` selects a Databricks CLI profile.
- `--host <url>` selects a workspace or accounts host.
- `--account-id <id>` and `--workspace-id <id>` provide target identifiers.
- `--config-file <path>` selects the Databricks configuration file.
- `--client-id <id>` selects the OAuth client.
- `--group-id <id>` requests an assumed group role for M2M.
- `--auth-type databricks-cli|oauth-m2m` selects the auth strategy.
- `--no-prefer-user-to-machine` keeps an implicitly selected M2M profile.
- `--scopes <scopes>` accepts a comma-separated value and may be repeated.
- `--target workspace|account|unified` selects the OAuth target.
- `--storage auto|memory|file` selects credential storage.
- `--cache-dir <path>` selects the file-storage directory.
- `--callback-image-src <src>` sets the callback logo URL or data URI.
- `--lock-timeout-seconds`, `--login-timeout-seconds`, and
  `--refresh-buffer-seconds` control auth timing.

The Databricks options also read their standard `DATABRICKS_*` environment
variables. U2M storage and timeout options read the matching
`DBX_TOOLS_U2M_*` variables shown by `dbx auth --help`.
M2M reads `client_id` and `client_secret` from the selected profile or their
standard Databricks environment variables. The secret is not accepted as a CLI
argument or included in generated binding records.

For U2M with automatic storage, the Rust package checks
`databricks auth --help` once per process outside Databricks Apps. When
available, token refresh runs through
`databricks auth token --profile <name>`. Otherwise it uses the native
file-backed OAuth flow. Automatic storage resolves to memory inside a
Databricks App. Explicit file storage always uses the native flow. Memory
storage uses neither the Databricks CLI nor file persistence. M2M always uses
the native client-credentials flow.

## Package use

This package ships no bin. [`@dbx-tools/cli`](../dbx-tools) imports
`buildProgram()` lazily and mounts it as `dbx auth`.

```ts
import { cli } from "@dbx-tools/cli-auth";

await cli.buildProgram().parseAsync(["status"], { from: "user" });
```

Applications that need programmatic OAuth should import
[`@dbx-tools/databricks-auth`](../../node/databricks-auth) directly.

## Modules

- `cli` - Commander program, option translation, command routing, and JSON
  output.
