# @dbx-tools/cli

Use one CLI to authenticate with Databricks, connect local PostgreSQL tools to
Lakebase, serve Databricks models to coding agents, run graph memory, and share
applications through a gated public URL.

## Install And Connect

```sh
bun add --global @dbx-tools/cli
dbx auth login --profile MY-PROFILE
dbx auth status --profile MY-PROFILE
```

`dbx-tools` is an alias for `dbx`. Choose a configured Databricks profile for
workspace commands; the examples use `MY-PROFILE` as a placeholder.

## Serve Models To Local Tools

```sh
dbx model-gateway --profile MY-PROFILE --port 4000
```

Point an OpenAI-compatible client at `http://127.0.0.1:4000/v1`. The generated
command reference includes all gateway and desktop-service options.

## Connect To Lakebase

```sh
dbx lakebase-proxy --profile MY-PROFILE --port 5432
```

Connect your PostgreSQL client to the loopback listener. The command reference
includes target selection, connection URLs, and service commands.

## Add Memory Or Share An App

```sh
dbx graphiti --profile MY-PROFILE
dbx tunnel --allow example.com -- bun src/server.ts
```

`graphiti` provides graph memory for agents. `tunnel` adds a public URL with
passwordless access to an existing process.

## Export AppKit Configuration

```sh
eval "$(dbx appkit env --quiet)"
```

Use the resolved AppKit environment before starting another process. The AppKit
and authentication command groups below include JSON, Windows, and token options.

## Bootstrap A Workspace

```sh
dbx dev sync
```

In an empty folder, this creates and initializes a Bun/Projen workspace. In a
cloned workspace, it installs missing tooling before running the requested task.
Arguments after `dev` are forwarded to Projen.

Once the workspace is initialized, use its tasks directly:

```sh
bun run sync
bun run sync -- --watch
bun run barrels
```

See [`@dbx-tools/projen`](../../../../projen) for workspace configuration and
generation. Command implementations are available from `@dbx-tools/cli/appkit`,
`/auth`, `/graphiti`, `/lakebase-proxy`, `/model-gateway`, and `/tunnel` when a
Node caller needs to embed one parser.

<!-- cli-reference:start -->

## Command Reference

### `dbx`

Databricks developer tools: workspace lifecycle, AppKit env, auth, tunnels, and local proxies

```sh
dbx [command]
```

#### Commands

| Command                         | Description                                                             |
| ------------------------------- | ----------------------------------------------------------------------- |
| `dev [projenArgs...]`           | Bootstrap or repair a dbx-tools workspace, then forward to projen       |
| `appkit`                        | AppKit helpers: resolve the environment an AppKit app would start with. |
| `auth [options]`                | Authenticate to Databricks with user or machine OAuth                   |
| `tunnel [options] [command...]` | Front a command with a public tunnel and passwordless auth              |
| `lakebase-proxy [options]`      | Run a loopback PostgreSQL proxy for Databricks Lakebase                 |
| `model-gateway [options]`       | Run or manage the AppKit Databricks model gateway                       |
| `graphiti [options]`            | Run Graphiti or manage its current-user desktop service                 |

### `dbx dev`

Bootstrap or repair a dbx-tools workspace, then forward to projen

```sh
dbx dev [projenArgs...]
```

#### Arguments

| Argument     | Description                                   |
| ------------ | --------------------------------------------- |
| `projenArgs` | projen task and arguments (e.g. sync --watch) |

### `dbx appkit`

AppKit helpers: resolve the environment an AppKit app would start with.

```sh
appkit [command]
```

#### Commands

| Command         | Description                                            |
| --------------- | ------------------------------------------------------ |
| `env [options]` | Run AppKit auto-config and print new/changed env vars. |

### `dbx appkit env`

Run AppKit auto-config and print new/changed env vars.

```sh
appkit env [options]
```

#### Options

| Option             | Description                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `--format <value>` | Output format: export, windows, or json. (choices: "export", "windows", "json", default: "export", env: FORMAT) |
| `--quiet`          | Suppress auto-config log output. (default: false, env: QUIET)                                                   |
| `--no-quiet`       | Disable suppress auto-config log output.                                                                        |

### `dbx auth`

Authenticate to Databricks with user or machine OAuth

```sh
auth [options] [command]
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
auth login
```

### `dbx auth token`

Return a valid access token, logging in when needed

```sh
auth token [options]
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
auth profile
```

### `dbx auth logout`

Delete the stored credential for the selected profile

```sh
auth logout
```

### `dbx auth status`

Show the resolved authentication client configuration

```sh
auth status
```

### `dbx tunnel`

Front a command with a public tunnel and passwordless auth

```sh
tunnel [options] [command] [command...]
```

#### Arguments

| Argument  | Description                     |
| --------- | ------------------------------- |
| `command` | the command to wrap, after `--` |

#### Options

| Option                          | Description                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `--transport <value>`           | Public tunnel transport. (choices: "portr", "frp", "both", env: TUNNEL_TRANSPORT)               |
| `--public-domain <value>`       | Public tunnel domain. (env: TUNNEL_PUBLIC_DOMAIN)                                               |
| `--subdomain <value>`           | Portr subdomain. (env: SUBDOMAIN)                                                               |
| `--port <value>`                | Public listener port. (env: DATABRICKS_APP_PORT)                                                |
| `--app-port <value>`            | Private wrapped application port. (env: TUNNEL_APP_PORT)                                        |
| `--allow <value>`               | Email allow-list patterns. (env: TUNNEL_AUTH_ALLOW)                                             |
| `--subject <value>`             | Verification email subject. (env: TUNNEL_AUTH_SUBJECT)                                          |
| `--brand-name <value>`          | Verification email brand name. (env: TUNNEL_AUTH_BRAND_NAME)                                    |
| `--message <value>`             | Verification email message. (env: TUNNEL_AUTH_MESSAGE)                                          |
| `--session-ttl-seconds <value>` | Session lifetime in seconds. (env: TUNNEL_AUTH_SESSION_TTL)                                     |
| `--code-ttl-seconds <value>`    | One-time-code lifetime in seconds. (env: TUNNEL_AUTH_CODE_TTL)                                  |
| `--session-cutoff <value>`      | Invalidate sessions issued before this value. (env: TUNNEL_AUTH_SESSION_CUTOFF)                 |
| `--storage <value>`             | Authentication database mode. (choices: "auto", "lakebase", "sqlite", env: TUNNEL_AUTH_STORAGE) |
| `--sqlite-path <value>`         | Local authentication SQLite file. (env: TUNNEL_AUTH_SQLITE_PATH)                                |
| `--forward-headers <value>`     | Additional forwarded request header patterns. (env: TUNNEL_FORWARD_HEADERS)                     |
| `--gate-paths <value>`          | Additional path prefixes requiring authentication. (env: TUNNEL_GATE_PATHS)                     |
| `--bind-hosts <value>`          | Interface IPs the gate listens on. (env: BIND_HOSTS)                                            |
| `--insecure`                    | Run without an authentication gate. (env: TUNNEL_INSECURE)                                      |
| `--no-insecure`                 | Disable run without an authentication gate.                                                     |
| `--frp-server <value>`          | FRP control host. (env: FRP_SERVER)                                                             |
| `--frp-public-domain <value>`   | FRP public HTTP domain. (env: TUNNEL_FRP_PUBLIC_DOMAIN)                                         |
| `--frp-server-port <value>`     | FRP control port. (env: FRP_SERVER_PORT)                                                        |
| `--frp-protocol <value>`        | FRP transport protocol. (env: FRP_PROTOCOL)                                                     |
| `--frp-token <value>`           | FRP authentication token. (env: FRP_TOKEN)                                                      |
| `--frp-proxy-name <value>`      | FRP proxy registration name. (env: FRP_PROXY_NAME)                                              |

#### Commands

| Command                      | Description                                    |
| ---------------------------- | ---------------------------------------------- |
| `run [options] <command...>` | Wrap a command (the default action)            |
| `status [options]`           | Resolve the configuration and print it         |
| `install [transport]`        | Install public tunnel client binaries and exit |

### `dbx tunnel run`

Wrap a command (the default action)

```sh
tunnel run [options] <command...>
```

#### Arguments

| Argument  | Description                     |
| --------- | ------------------------------- |
| `command` | the command to wrap, after `--` |

#### Options

| Option                          | Description                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `--transport <value>`           | Public tunnel transport. (choices: "portr", "frp", "both", env: TUNNEL_TRANSPORT)               |
| `--public-domain <value>`       | Public tunnel domain. (env: TUNNEL_PUBLIC_DOMAIN)                                               |
| `--subdomain <value>`           | Portr subdomain. (env: SUBDOMAIN)                                                               |
| `--port <value>`                | Public listener port. (env: DATABRICKS_APP_PORT)                                                |
| `--app-port <value>`            | Private wrapped application port. (env: TUNNEL_APP_PORT)                                        |
| `--allow <value>`               | Email allow-list patterns. (env: TUNNEL_AUTH_ALLOW)                                             |
| `--subject <value>`             | Verification email subject. (env: TUNNEL_AUTH_SUBJECT)                                          |
| `--brand-name <value>`          | Verification email brand name. (env: TUNNEL_AUTH_BRAND_NAME)                                    |
| `--message <value>`             | Verification email message. (env: TUNNEL_AUTH_MESSAGE)                                          |
| `--session-ttl-seconds <value>` | Session lifetime in seconds. (env: TUNNEL_AUTH_SESSION_TTL)                                     |
| `--code-ttl-seconds <value>`    | One-time-code lifetime in seconds. (env: TUNNEL_AUTH_CODE_TTL)                                  |
| `--session-cutoff <value>`      | Invalidate sessions issued before this value. (env: TUNNEL_AUTH_SESSION_CUTOFF)                 |
| `--storage <value>`             | Authentication database mode. (choices: "auto", "lakebase", "sqlite", env: TUNNEL_AUTH_STORAGE) |
| `--sqlite-path <value>`         | Local authentication SQLite file. (env: TUNNEL_AUTH_SQLITE_PATH)                                |
| `--forward-headers <value>`     | Additional forwarded request header patterns. (env: TUNNEL_FORWARD_HEADERS)                     |
| `--gate-paths <value>`          | Additional path prefixes requiring authentication. (env: TUNNEL_GATE_PATHS)                     |
| `--bind-hosts <value>`          | Interface IPs the gate listens on. (env: BIND_HOSTS)                                            |
| `--insecure`                    | Run without an authentication gate. (env: TUNNEL_INSECURE)                                      |
| `--no-insecure`                 | Disable run without an authentication gate.                                                     |
| `--frp-server <value>`          | FRP control host. (env: FRP_SERVER)                                                             |
| `--frp-public-domain <value>`   | FRP public HTTP domain. (env: TUNNEL_FRP_PUBLIC_DOMAIN)                                         |
| `--frp-server-port <value>`     | FRP control port. (env: FRP_SERVER_PORT)                                                        |
| `--frp-protocol <value>`        | FRP transport protocol. (env: FRP_PROTOCOL)                                                     |
| `--frp-token <value>`           | FRP authentication token. (env: FRP_TOKEN)                                                      |
| `--frp-proxy-name <value>`      | FRP proxy registration name. (env: FRP_PROXY_NAME)                                              |

### `dbx tunnel status`

Resolve the configuration and print it

```sh
tunnel status [options]
```

#### Options

| Option                          | Description                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `--transport <value>`           | Public tunnel transport. (choices: "portr", "frp", "both", env: TUNNEL_TRANSPORT)               |
| `--public-domain <value>`       | Public tunnel domain. (env: TUNNEL_PUBLIC_DOMAIN)                                               |
| `--subdomain <value>`           | Portr subdomain. (env: SUBDOMAIN)                                                               |
| `--port <value>`                | Public listener port. (env: DATABRICKS_APP_PORT)                                                |
| `--app-port <value>`            | Private wrapped application port. (env: TUNNEL_APP_PORT)                                        |
| `--allow <value>`               | Email allow-list patterns. (env: TUNNEL_AUTH_ALLOW)                                             |
| `--subject <value>`             | Verification email subject. (env: TUNNEL_AUTH_SUBJECT)                                          |
| `--brand-name <value>`          | Verification email brand name. (env: TUNNEL_AUTH_BRAND_NAME)                                    |
| `--message <value>`             | Verification email message. (env: TUNNEL_AUTH_MESSAGE)                                          |
| `--session-ttl-seconds <value>` | Session lifetime in seconds. (env: TUNNEL_AUTH_SESSION_TTL)                                     |
| `--code-ttl-seconds <value>`    | One-time-code lifetime in seconds. (env: TUNNEL_AUTH_CODE_TTL)                                  |
| `--session-cutoff <value>`      | Invalidate sessions issued before this value. (env: TUNNEL_AUTH_SESSION_CUTOFF)                 |
| `--storage <value>`             | Authentication database mode. (choices: "auto", "lakebase", "sqlite", env: TUNNEL_AUTH_STORAGE) |
| `--sqlite-path <value>`         | Local authentication SQLite file. (env: TUNNEL_AUTH_SQLITE_PATH)                                |
| `--forward-headers <value>`     | Additional forwarded request header patterns. (env: TUNNEL_FORWARD_HEADERS)                     |
| `--gate-paths <value>`          | Additional path prefixes requiring authentication. (env: TUNNEL_GATE_PATHS)                     |
| `--bind-hosts <value>`          | Interface IPs the gate listens on. (env: BIND_HOSTS)                                            |
| `--insecure`                    | Run without an authentication gate. (env: TUNNEL_INSECURE)                                      |
| `--no-insecure`                 | Disable run without an authentication gate.                                                     |
| `--frp-server <value>`          | FRP control host. (env: FRP_SERVER)                                                             |
| `--frp-public-domain <value>`   | FRP public HTTP domain. (env: TUNNEL_FRP_PUBLIC_DOMAIN)                                         |
| `--frp-server-port <value>`     | FRP control port. (env: FRP_SERVER_PORT)                                                        |
| `--frp-protocol <value>`        | FRP transport protocol. (env: FRP_PROTOCOL)                                                     |
| `--frp-token <value>`           | FRP authentication token. (env: FRP_TOKEN)                                                      |
| `--frp-proxy-name <value>`      | FRP proxy registration name. (env: FRP_PROXY_NAME)                                              |

### `dbx tunnel install`

Install public tunnel client binaries and exit

```sh
tunnel install [transport]
```

#### Arguments

| Argument    | Description                            |
| ----------- | -------------------------------------- |
| `transport` | portr, frp, or both (default: "portr") |

### `dbx lakebase-proxy`

Run a loopback PostgreSQL proxy for Databricks Lakebase

```sh
lakebase-proxy [options] [command]
```

#### Options

| Option                              | Description                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `-V, --version`                     | output the version number                                                    |
| `--postgres-role <value>`           | PostgreSQL role assumed after authentication. (env: DBX_TOOLS_POSTGRES_ROLE) |
| `--listen <value>`                  | Loopback listener address. (default: tcp://localhost:5432, env: LISTEN)      |
| `--startup-timeout-seconds <value>` | Startup timeout in seconds. (default: 30, env: STARTUP_TIMEOUT_SECONDS)      |
| `--profile <value>`                 | Exact Databricks profile. (env: DATABRICKS_CONFIG_PROFILE)                   |

#### Commands

| Command         | Description                                         |
| --------------- | --------------------------------------------------- |
| `url [options]` | Format a local PostgreSQL URL for a Lakebase target |
| `service`       | Install and manage the desktop service              |

### `dbx lakebase-proxy url`

Format a local PostgreSQL URL for a Lakebase target

```sh
lakebase-proxy url [options]
```

#### Options

| Option             | Description                                                       |
| ------------------ | ----------------------------------------------------------------- |
| `--target <value>` | Lakebase project, resource path, host, or URL. (env: TARGET)      |
| `--listen <value>` | Local proxy address. (default: tcp://localhost:5432, env: LISTEN) |

### `dbx lakebase-proxy service`

Install and manage the desktop service

```sh
lakebase-proxy service [command]
```

#### Commands

| Command             | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `install [options]` | Install the service for the current user and start it |
| `start`             | Start the installed service                           |
| `stop`              | Stop the running service                              |
| `restart`           | Restart the installed service                         |
| `status`            | Print service installation and process state as JSON  |
| `uninstall`         | Stop and remove the service for the current user      |

### `dbx lakebase-proxy service install`

Install the service for the current user and start it

```sh
lakebase-proxy service install [options]
```

#### Options

| Option                              | Description                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `--no-start`                        | Do not start the service after installation                                  |
| `--postgres-role <value>`           | PostgreSQL role assumed after authentication. (env: DBX_TOOLS_POSTGRES_ROLE) |
| `--listen <value>`                  | Loopback listener address. (default: tcp://localhost:5432, env: LISTEN)      |
| `--startup-timeout-seconds <value>` | Startup timeout in seconds. (default: 30, env: STARTUP_TIMEOUT_SECONDS)      |
| `--profile <value>`                 | Exact Databricks profile. (env: DATABRICKS_CONFIG_PROFILE)                   |

### `dbx lakebase-proxy service start`

Start the installed service

```sh
lakebase-proxy service start
```

### `dbx lakebase-proxy service stop`

Stop the running service

```sh
lakebase-proxy service stop
```

### `dbx lakebase-proxy service restart`

Restart the installed service

```sh
lakebase-proxy service restart
```

### `dbx lakebase-proxy service status`

Print service installation and process state as JSON

```sh
lakebase-proxy service status
```

### `dbx lakebase-proxy service uninstall`

Stop and remove the service for the current user

```sh
lakebase-proxy service uninstall
```

### `dbx model-gateway`

Run or manage the AppKit Databricks model gateway

```sh
model-gateway [options] [command]
```

#### Options

| Option                 | Description                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `-v, --version`        | output the version number                                                                  |
| `--listen <value>`     | Loopback listener address. (default: tcp://localhost:4000, env: LISTEN)                    |
| `--profile <value>`    | Databricks profile used for model discovery and requests. (env: DATABRICKS_CONFIG_PROFILE) |
| `--body-limit <value>` | Maximum JSON request body size. (default: "100mb", env: BODY_LIMIT)                        |
| `--runtime-info`       | Print runtime implementation metadata. (default: false, env: RUNTIME_INFO)                 |
| `--no-runtime-info`    | Disable print runtime implementation metadata.                                             |

#### Commands

| Command   | Description                            |
| --------- | -------------------------------------- |
| `service` | Install and manage the desktop service |

### `dbx model-gateway service`

Install and manage the desktop service

```sh
model-gateway service [command]
```

#### Commands

| Command             | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `install [options]` | Install the service for the current user and start it |
| `start`             | Start the installed service                           |
| `stop`              | Stop the running service                              |
| `restart`           | Restart the installed service                         |
| `status`            | Print service installation and process state as JSON  |
| `uninstall`         | Stop and remove the service for the current user      |

### `dbx model-gateway service install`

Install the service for the current user and start it

```sh
model-gateway service install [options]
```

#### Options

| Option       | Description                                 |
| ------------ | ------------------------------------------- |
| `--no-start` | Do not start the service after installation |

### `dbx model-gateway service start`

Start the installed service

```sh
model-gateway service start
```

### `dbx model-gateway service stop`

Stop the running service

```sh
model-gateway service stop
```

### `dbx model-gateway service restart`

Restart the installed service

```sh
model-gateway service restart
```

### `dbx model-gateway service status`

Print service installation and process state as JSON

```sh
model-gateway service status
```

### `dbx model-gateway service uninstall`

Stop and remove the service for the current user

```sh
model-gateway service uninstall
```

### `dbx graphiti`

Run Graphiti or manage its current-user desktop service

```sh
graphiti [options] [command]
```

#### Options

| Option                             | Description                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `-v, --version`                    | output the version number                                                                                                            |
| `--profile <value>`                | Databricks profile used for model discovery and authentication. (env: DATABRICKS_CONFIG_PROFILE)                                     |
| `--graphiti-home <value>`          | Application-owned Graphiti runtime directory. (env: GRAPHITI_HOME)                                                                   |
| `--model <value>`                  | Fuzzy chat-model name or endpoint identifier. (default: "databricks-gpt-5-nano", env: MODEL_NAME)                                    |
| `--temperature <value>`            | Sampling temperature forwarded to the Graphiti LLM client. (default: 1, env: TEMPERATURE)                                            |
| `--embedder-model <value>`         | Fuzzy embedding-model name or endpoint identifier. (default: "gte-large-en", env: EMBEDDER_MODEL)                                    |
| `--embedder-dimensions <value>`    | Embedding vector dimensions expected by Graphiti. (default: 1024, env: EMBEDDER_DIMENSIONS)                                          |
| `--structured-output-mode <value>` | Structured-output mode forwarded to Graphiti's OpenAI provider. (default: "json_object", env: LLM_STRUCTURED_OUTPUT_MODE)            |
| `--startup-timeout-ms <value>`     | Maximum milliseconds allowed for the Graphiti runtime to become ready. (default: 180000, env: DBX_TOOLS_GRAPHITI_STARTUP_TIMEOUT_MS) |
| `--listen <value>`                 | Graphiti HTTP listener. (default: tcp://127.0.0.1:7272, env: GRAPHITI_LISTEN)                                                        |
| `--database-url <value>`           | PostgreSQL URL or Lakebase target. Omit it to use persistent embedded PostgreSQL. (env: LAKEBASE_ENDPOINT)                           |
| `--database-schema <value>`        | PostgreSQL schema used for Lakebase graph tables. (default: "dbx_tools_graphiti", env: GRAPHITI_DATABASE_SCHEMA)                     |
| `--postgres-role <value>`          | PostgreSQL role assumed after authentication. (env: DBX_TOOLS_POSTGRES_ROLE)                                                         |

#### Commands

| Command   | Description                            |
| --------- | -------------------------------------- |
| `service` | Install and manage the desktop service |

### `dbx graphiti service`

Install and manage the desktop service

```sh
graphiti service [command]
```

#### Commands

| Command             | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `install [options]` | Install the service for the current user and start it |
| `start`             | Start the installed service                           |
| `stop`              | Stop the running service                              |
| `restart`           | Restart the installed service                         |
| `status`            | Print service installation and process state as JSON  |
| `uninstall`         | Stop and remove the service for the current user      |

### `dbx graphiti service install`

Install the service for the current user and start it

```sh
graphiti service install [options]
```

#### Options

| Option       | Description                                 |
| ------------ | ------------------------------------------- |
| `--no-start` | Do not start the service after installation |

### `dbx graphiti service start`

Start the installed service

```sh
graphiti service start
```

### `dbx graphiti service stop`

Stop the running service

```sh
graphiti service stop
```

### `dbx graphiti service restart`

Restart the installed service

```sh
graphiti service restart
```

### `dbx graphiti service status`

Print service installation and process state as JSON

```sh
graphiti service status
```

### `dbx graphiti service uninstall`

Stop and remove the service for the current user

```sh
graphiti service uninstall
```

<!-- cli-reference:end -->
