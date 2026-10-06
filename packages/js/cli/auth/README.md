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
configured profile name. Use `--host` or a configuration file override when
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

```text
Usage: dbx auth [options] [command]

Authenticate to Databricks with user or machine OAuth

Options:
  --profile <name>             Databricks CLI profile (env: DATABRICKS_CONFIG_PROFILE)
  --host <url>                 Databricks host (env: DATABRICKS_HOST)
  --account-id <id>            Databricks account id (env: DATABRICKS_ACCOUNT_ID)
  --workspace-id <id>          Databricks workspace id (env: DATABRICKS_WORKSPACE_ID)
  --config-file <path>         Databricks config file (env: DATABRICKS_CONFIG_FILE)
  --client-id <id>             OAuth client id (env: DATABRICKS_CLIENT_ID)
  --group-id <id>              Assumed Databricks group id (env: DATABRICKS_GROUP_ID)
  --auth-type <type>           Databricks authentication type (choices: "databricks-cli",
                               "oauth-m2m", "pat", "app_obo", "app_sp", env: DATABRICKS_AUTH_TYPE)
  --scopes <scopes>            OAuth scopes, repeatable or comma-separated
  --target <target>            OAuth target (choices: "workspace", "account", "unified", env:
                               DBX_TOOLS_U2M_TARGET)
  --lock-timeout-ms <ms>       Credential lock timeout (0 waits indefinitely) (default: "0", env:
                               DBX_TOOLS_U2M_LOCK_TIMEOUT_MS)
  --login-timeout-ms <ms>      Browser login timeout (default: "900000", env:
                               DBX_TOOLS_U2M_LOGIN_TIMEOUT_MS)
  --refresh-buffer-ms <ms>     Token refresh buffer (default: "300000", env:
                               DBX_TOOLS_U2M_REFRESH_BUFFER_MS)
  --no-prefer-user-to-machine  Use selected M2M credentials without preferring a matching user
                               profile

Commands:
  login                        Force browser login and return an access token
  token [options]              Return a valid access token, logging in when needed
  profile                      Print the configured or automatically detected profile
  logout                       Delete the stored credential for the selected profile
  status                       Show the resolved authentication client configuration
```

### `dbx auth login`

```text
Usage: dbx auth login

Force browser login and return an access token

Global Options:
  --profile <name>             Databricks CLI profile (env: DATABRICKS_CONFIG_PROFILE)
  --host <url>                 Databricks host (env: DATABRICKS_HOST)
  --account-id <id>            Databricks account id (env: DATABRICKS_ACCOUNT_ID)
  --workspace-id <id>          Databricks workspace id (env: DATABRICKS_WORKSPACE_ID)
  --config-file <path>         Databricks config file (env: DATABRICKS_CONFIG_FILE)
  --client-id <id>             OAuth client id (env: DATABRICKS_CLIENT_ID)
  --group-id <id>              Assumed Databricks group id (env: DATABRICKS_GROUP_ID)
  --auth-type <type>           Databricks authentication type (choices: "databricks-cli",
                               "oauth-m2m", "pat", "app_obo", "app_sp", env: DATABRICKS_AUTH_TYPE)
  --scopes <scopes>            OAuth scopes, repeatable or comma-separated
  --target <target>            OAuth target (choices: "workspace", "account", "unified", env:
                               DBX_TOOLS_U2M_TARGET)
  --lock-timeout-ms <ms>       Credential lock timeout (0 waits indefinitely) (default: "0", env:
                               DBX_TOOLS_U2M_LOCK_TIMEOUT_MS)
  --login-timeout-ms <ms>      Browser login timeout (default: "900000", env:
                               DBX_TOOLS_U2M_LOGIN_TIMEOUT_MS)
  --refresh-buffer-ms <ms>     Token refresh buffer (default: "300000", env:
                               DBX_TOOLS_U2M_REFRESH_BUFFER_MS)
  --no-prefer-user-to-machine  Use selected M2M credentials without preferring a matching user
                               profile
```

### `dbx auth token`

```text
Usage: dbx auth token [options]

Return a valid access token, logging in when needed

Options:
  --force-refresh              Refresh the token before returning it
  --no-login                   Fail instead of logging in for a missing or invalid credential

Global Options:
  --profile <name>             Databricks CLI profile (env: DATABRICKS_CONFIG_PROFILE)
  --host <url>                 Databricks host (env: DATABRICKS_HOST)
  --account-id <id>            Databricks account id (env: DATABRICKS_ACCOUNT_ID)
  --workspace-id <id>          Databricks workspace id (env: DATABRICKS_WORKSPACE_ID)
  --config-file <path>         Databricks config file (env: DATABRICKS_CONFIG_FILE)
  --client-id <id>             OAuth client id (env: DATABRICKS_CLIENT_ID)
  --group-id <id>              Assumed Databricks group id (env: DATABRICKS_GROUP_ID)
  --auth-type <type>           Databricks authentication type (choices: "databricks-cli",
                               "oauth-m2m", "pat", "app_obo", "app_sp", env: DATABRICKS_AUTH_TYPE)
  --scopes <scopes>            OAuth scopes, repeatable or comma-separated
  --target <target>            OAuth target (choices: "workspace", "account", "unified", env:
                               DBX_TOOLS_U2M_TARGET)
  --lock-timeout-ms <ms>       Credential lock timeout (0 waits indefinitely) (default: "0", env:
                               DBX_TOOLS_U2M_LOCK_TIMEOUT_MS)
  --login-timeout-ms <ms>      Browser login timeout (default: "900000", env:
                               DBX_TOOLS_U2M_LOGIN_TIMEOUT_MS)
  --refresh-buffer-ms <ms>     Token refresh buffer (default: "300000", env:
                               DBX_TOOLS_U2M_REFRESH_BUFFER_MS)
  --no-prefer-user-to-machine  Use selected M2M credentials without preferring a matching user
                               profile
```

### `dbx auth profile`

```text
Usage: dbx auth profile

Print the configured or automatically detected profile

Global Options:
  --profile <name>             Databricks CLI profile (env: DATABRICKS_CONFIG_PROFILE)
  --host <url>                 Databricks host (env: DATABRICKS_HOST)
  --account-id <id>            Databricks account id (env: DATABRICKS_ACCOUNT_ID)
  --workspace-id <id>          Databricks workspace id (env: DATABRICKS_WORKSPACE_ID)
  --config-file <path>         Databricks config file (env: DATABRICKS_CONFIG_FILE)
  --client-id <id>             OAuth client id (env: DATABRICKS_CLIENT_ID)
  --group-id <id>              Assumed Databricks group id (env: DATABRICKS_GROUP_ID)
  --auth-type <type>           Databricks authentication type (choices: "databricks-cli",
                               "oauth-m2m", "pat", "app_obo", "app_sp", env: DATABRICKS_AUTH_TYPE)
  --scopes <scopes>            OAuth scopes, repeatable or comma-separated
  --target <target>            OAuth target (choices: "workspace", "account", "unified", env:
                               DBX_TOOLS_U2M_TARGET)
  --lock-timeout-ms <ms>       Credential lock timeout (0 waits indefinitely) (default: "0", env:
                               DBX_TOOLS_U2M_LOCK_TIMEOUT_MS)
  --login-timeout-ms <ms>      Browser login timeout (default: "900000", env:
                               DBX_TOOLS_U2M_LOGIN_TIMEOUT_MS)
  --refresh-buffer-ms <ms>     Token refresh buffer (default: "300000", env:
                               DBX_TOOLS_U2M_REFRESH_BUFFER_MS)
  --no-prefer-user-to-machine  Use selected M2M credentials without preferring a matching user
                               profile
```

### `dbx auth logout`

```text
Usage: dbx auth logout

Delete the stored credential for the selected profile

Global Options:
  --profile <name>             Databricks CLI profile (env: DATABRICKS_CONFIG_PROFILE)
  --host <url>                 Databricks host (env: DATABRICKS_HOST)
  --account-id <id>            Databricks account id (env: DATABRICKS_ACCOUNT_ID)
  --workspace-id <id>          Databricks workspace id (env: DATABRICKS_WORKSPACE_ID)
  --config-file <path>         Databricks config file (env: DATABRICKS_CONFIG_FILE)
  --client-id <id>             OAuth client id (env: DATABRICKS_CLIENT_ID)
  --group-id <id>              Assumed Databricks group id (env: DATABRICKS_GROUP_ID)
  --auth-type <type>           Databricks authentication type (choices: "databricks-cli",
                               "oauth-m2m", "pat", "app_obo", "app_sp", env: DATABRICKS_AUTH_TYPE)
  --scopes <scopes>            OAuth scopes, repeatable or comma-separated
  --target <target>            OAuth target (choices: "workspace", "account", "unified", env:
                               DBX_TOOLS_U2M_TARGET)
  --lock-timeout-ms <ms>       Credential lock timeout (0 waits indefinitely) (default: "0", env:
                               DBX_TOOLS_U2M_LOCK_TIMEOUT_MS)
  --login-timeout-ms <ms>      Browser login timeout (default: "900000", env:
                               DBX_TOOLS_U2M_LOGIN_TIMEOUT_MS)
  --refresh-buffer-ms <ms>     Token refresh buffer (default: "300000", env:
                               DBX_TOOLS_U2M_REFRESH_BUFFER_MS)
  --no-prefer-user-to-machine  Use selected M2M credentials without preferring a matching user
                               profile
```

### `dbx auth status`

```text
Usage: dbx auth status

Show the resolved authentication client configuration

Global Options:
  --profile <name>             Databricks CLI profile (env: DATABRICKS_CONFIG_PROFILE)
  --host <url>                 Databricks host (env: DATABRICKS_HOST)
  --account-id <id>            Databricks account id (env: DATABRICKS_ACCOUNT_ID)
  --workspace-id <id>          Databricks workspace id (env: DATABRICKS_WORKSPACE_ID)
  --config-file <path>         Databricks config file (env: DATABRICKS_CONFIG_FILE)
  --client-id <id>             OAuth client id (env: DATABRICKS_CLIENT_ID)
  --group-id <id>              Assumed Databricks group id (env: DATABRICKS_GROUP_ID)
  --auth-type <type>           Databricks authentication type (choices: "databricks-cli",
                               "oauth-m2m", "pat", "app_obo", "app_sp", env: DATABRICKS_AUTH_TYPE)
  --scopes <scopes>            OAuth scopes, repeatable or comma-separated
  --target <target>            OAuth target (choices: "workspace", "account", "unified", env:
                               DBX_TOOLS_U2M_TARGET)
  --lock-timeout-ms <ms>       Credential lock timeout (0 waits indefinitely) (default: "0", env:
                               DBX_TOOLS_U2M_LOCK_TIMEOUT_MS)
  --login-timeout-ms <ms>      Browser login timeout (default: "900000", env:
                               DBX_TOOLS_U2M_LOGIN_TIMEOUT_MS)
  --refresh-buffer-ms <ms>     Token refresh buffer (default: "300000", env:
                               DBX_TOOLS_U2M_REFRESH_BUFFER_MS)
  --no-prefer-user-to-machine  Use selected M2M credentials without preferring a matching user
                               profile
```

<!-- cli-reference:end -->
