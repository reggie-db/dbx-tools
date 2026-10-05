# `@dbx-tools/cli-auth`

Databricks OAuth commands mounted under `dbx auth`.

The package uses [`@dbx-tools/auth`](../../node/auth) for profile resolution,
CLI-owned U2M, M2M client credentials, PAT access, token refresh, and locking.

Key features:

- Databricks CLI login for workspace, account, and unified OAuth targets;
- M2M client-credentials tokens with HTTP Basic client authentication;
- PAT profiles from Databricks configuration or `DATABRICKS_TOKEN`;
- U2M preference by default, with standard M2M resolution available through
  `--no-prefer-user-to-machine`;
- Databricks CLI token refresh;
- access-token lookup with automatic login, a non-interactive opt-out, and
  forced refresh;
- profile and host resolution compatible with Databricks configuration;
- JSON output that excludes refresh credentials;
- one `dbx` installation, with native auth code loaded only for `dbx auth`.

## Commands

```sh
dbx auth login --profile DEFAULT
dbx auth token --profile DEFAULT
dbx auth token --profile DEFAULT --no-login
dbx auth token --profile DEFAULT --force-refresh
dbx auth profile
dbx auth status --profile DEFAULT
dbx auth logout --profile DEFAULT
```

`login` and `token` write access-token JSON to stdout. `token` automatically
runs login when a U2M credential is missing or cannot refresh; `--no-login`
makes it fail instead. The same policy applies with `--force-refresh`.
`profile` writes only the configured or detected profile name. `status` writes
the resolved profile and identity. `logout` produces no output when
it succeeds.

Implicit profile selection uses `__settings__.default_profile`, an existing
`DEFAULT` profile, the sole configured profile, then the `DEFAULT`
fallback.

## Common options

- `--profile <name>` selects a Databricks CLI profile.
- `--host <url>` selects a workspace or accounts host.
- `--account-id <id>` and `--workspace-id <id>` provide target identifiers.
- `--config-file <path>` selects the Databricks configuration file.
- `--client-id <id>` selects the OAuth client.
- `--group-id <id>` requests an assumed group role for M2M.
- `--auth-type <type>` selects a canonical Databricks auth type.
- `--no-prefer-user-to-machine` keeps an implicitly selected M2M profile.
- `--scopes <scopes>` accepts a comma-separated value and may be repeated.
- `--target workspace|account|unified` selects the OAuth target.
- `--lock-timeout-ms`, `--login-timeout-ms`, and `--refresh-buffer-ms` control
  auth timing in milliseconds. `--lock-timeout-ms` defaults to `0` (wait
  indefinitely for the refresh lock); browser login defaults to 15 minutes.

The Databricks options also read their standard `DATABRICKS_*` environment
variables. Timeout options read the matching `DBX_TOOLS_U2M_*` variables shown
by `dbx auth --help`.
M2M reads `client_id` and `client_secret` from the selected profile or their
standard Databricks environment variables. The secret is not accepted as a CLI
argument or included in generated binding records.
PAT reads `token` from the selected profile or `DATABRICKS_TOKEN`.

U2M requires an available Databricks CLI and delegates login, token acquisition,
refresh, and persistent credentials to it. M2M uses direct client credentials.
PAT and App credentials are resolved directly without persistent auth storage.

## Package use

This package ships no bin. [`@dbx-tools/cli`](../dbx-tools) imports
`buildProgram()` lazily and mounts it as `dbx auth`.

```ts
import { cli } from "@dbx-tools/cli-auth";

await cli.buildProgram().parseAsync(["status"], { from: "user" });
```

Applications that need programmatic authentication should import
[`@dbx-tools/auth`](../../node/auth) directly.

## Modules

- `cli` - Commander program, option translation, command routing, and JSON
  output.
