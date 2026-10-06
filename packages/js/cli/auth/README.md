# @dbx-tools/cli-auth

Sign in to Databricks, inspect a profile, and obtain access tokens for scripts
and local tools. The commands support user OAuth, service-principal credentials,
and personal access token profiles through `dbx auth`.

## Sign In And Check Access

Install the [`dbx` CLI](../dbx-tools), then select your workspace profile:

```sh
dbx auth login --profile MY-PROFILE
dbx auth status --profile MY-PROFILE
dbx auth profile
```

`login` opens the Databricks user authentication flow when needed. `status`
reports the selected identity and authentication state. `profile` prints the
configured profile name. Use `DATABRICKS_HOST` or a configuration file override when
connecting to a target outside the selected profile.

## Obtain A Token

```sh
dbx auth token --profile MY-PROFILE
dbx auth token --profile MY-PROFILE --force-refresh
```

Token commands print JSON containing the access token, token type, and available
expiry and scope information. Treat this output as a credential.

`token` can start a user login when credentials are missing or cannot refresh.
For a script that must fail instead of opening an interactive login:

```sh
dbx auth token --profile MY-PROFILE --no-login
```

## Use A Service Principal Or PAT

Select a profile configured with client credentials or a personal access token.
For machine authentication, keep that profile instead of preferring user OAuth:

```sh
dbx auth token --profile MY-SERVICE-PRINCIPAL --no-prefer-user-to-machine --no-login
```

Client secrets and PATs come from Databricks configuration or the corresponding
`DATABRICKS_*` environment variables, not command-line arguments. The generated
reference lists profile, target, scope, timeout, and refresh options together
with their environment-variable names.

## Sign Out

```sh
dbx auth logout --profile MY-PROFILE
```

For authentication inside an application rather than a shell command, use
[`@dbx-tools/auth`](../../node/auth). To mount these commands in another
Commander program, import `buildProgram` from `@dbx-tools/cli-auth/cli`.

<!-- cli-reference:start -->

## Command Reference

### `dbx auth`

Authenticate to Databricks with user or machine OAuth

```sh
dbx auth [options] [command]
```

#### Options

| Option                        | Description                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--profile <value>`           | Databricks CLI profile. (env: DATABRICKS_CONFIG_PROFILE)                                                       |
| `--scopes <value>`            | OAuth scopes. (default: [], env: SCOPES)                                                                       |
| `--target <value>`            | OAuth target. (choices: "workspace", "account", "unified", env: TARGET)                                        |
| `--lock-timeout-ms <value>`   | Credential lock timeout in milliseconds. (default: 0, env: LOCK_TIMEOUT_MS)                                    |
| `--login-timeout-ms <value>`  | Browser login timeout in milliseconds. (default: 900000, env: LOGIN_TIMEOUT_MS)                                |
| `--refresh-buffer-ms <value>` | Token refresh buffer in milliseconds. (default: 300000, env: REFRESH_BUFFER_MS)                                |
| `--prefer-user-to-machine`    | Prefer a matching user profile over selected machine credentials. (default: true, env: PREFER_USER_TO_MACHINE) |
| `--no-prefer-user-to-machine` | Disable prefer a matching user profile over selected machine credentials.                                      |

#### Commands

| Command           | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `login`           | Force browser login and return an access token         |
| `token [options]` | Return a valid access token, logging in when needed    |
| `profile`         | Print the configured or automatically detected profile |
| `logout`          | Delete the stored credential for the selected profile  |
| `status`          | Show the resolved authentication client configuration  |

### `dbx auth login`

Force browser login and return an access token

```sh
dbx auth login
```

### `dbx auth token`

Return a valid access token, logging in when needed

```sh
dbx auth token [options]
```

#### Options

| Option               | Description                                                                 |
| -------------------- | --------------------------------------------------------------------------- |
| `--force-refresh`    | Refresh the token before returning it. (default: false, env: FORCE_REFRESH) |
| `--no-force-refresh` | Disable refresh the token before returning it.                              |
| `--login`            | Log in when credentials are missing or invalid. (default: true, env: LOGIN) |
| `--no-login`         | Disable log in when credentials are missing or invalid.                     |

### `dbx auth profile`

Print the configured or automatically detected profile

```sh
dbx auth profile
```

### `dbx auth logout`

Delete the stored credential for the selected profile

```sh
dbx auth logout
```

### `dbx auth status`

Show the resolved authentication client configuration

```sh
dbx auth status
```

<!-- cli-reference:end -->
