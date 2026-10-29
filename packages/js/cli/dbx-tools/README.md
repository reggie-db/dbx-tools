# @dbx-tools/cli

Use `dbx` to authenticate with Databricks, connect local PostgreSQL tools to
Lakebase, expose workspace models to local clients, run graph memory, and share
an application through an access-controlled public URL.

## Install and connect

```sh
bun add --global @dbx-tools/cli
```

`dbx-tools` is an alias for `dbx`. Authentication and a configured Databricks
profile are resolved automatically. Examples that use `MY-PROFILE` show an
explicit override.

## Export a brand package

```sh
dbx brand "A neighborhood coffee company for morning commuters"
```

The command researches the broader web for brand facts and design direction,
then visits matching iOS App Store and Google Play pages for supplemental
visual references. It uses the downloaded icons and screenshots during
multimodal synthesis without treating the mobile designs as the full brand.
Plain status lines report web searches, store-page reads, image review, source
fetches, and synthesis as they happen.

By default, the command creates a unique operating-system temporary directory
and prints its paths when generation completes. The directory contains:

- `brand.yaml`, compatible with the shared dbx-tools brand context.
- `brand-package.json`, with source provenance and visual-reference metadata.
- `showcase.html`, a self-contained responsive brand presentation with desktop
  and mobile website mockups.
- `references/ios/` and `references/android/`, with the mobile images used for
  visual research.

For a persistent package with known brand coordinates:

```sh
dbx brand "Retail analytics for store operators" \
  --name "Acme Retail" \
  --website https://acme.example \
  --output branding/acme-retail
```

## Serve models to local tools

```sh
dbx model-gateway --profile MY-PROFILE --listen tcp://127.0.0.1:4000
```

Point an OpenAI-compatible client at
[http://127.0.0.1:4000/v1](http://127.0.0.1:4000/v1). The generated
command reference includes all gateway and desktop-service options.

Requests may omit `model` to select the best available chat endpoint. Clients
can select a class per request with the `x-dbx-tools-model-class` header.

Run the gateway in the foreground for one terminal session. Install its
current-user service when local tools need the endpoint after the terminal
closes:

```sh
dbx model-gateway service install
dbx model-gateway service status
```

Embed [@dbx-tools/appkit-model-gateway](../../node/appkit-model-gateway)
instead when the gateway belongs inside an AppKit application.

## Run Genie Code

`dbx genie` runs the Databricks Genie Code CLI with dbx-tools model discovery,
authentication, and configuration. It removes the setup steps normally required
before the first non-interactive Genie command:

- No Genie onboarding or separate `genie` initialization.
- No Genie configuration profile to create or pass.
- No manual provider URL, token command, workspace header, or `config.toml`.
- No explicit profile selection when dbx-tools discovers a configured
  Databricks profile.
- No restriction to Genie Code's default model. Select any compatible model
  available in the workspace, including GPT, Grok, Claude, Gemini, and custom
  serving endpoints.

With no model selection, dbx-tools chooses the best available tool-capable chat
model. Selection accepts a fuzzy or exact endpoint name or a capability band:

```sh
dbx genie
dbx genie --model-class chat-fast
dbx genie --profile MY-PROFILE --model databricks-gpt-5-6-sol
```

`dbx-genie` is the equivalent installed binary:

```sh
dbx-genie --model gpt
```

The command installs the pinned Genie Code package under `~/.dbx-tools` and
creates one persistent home per exact Databricks profile. Models share that
home's conversation state and project trust, while each invocation receives a
model-specific overlay with an independent local gateway port and credential.

Unknown flags, prompts, and extra arguments are forwarded to Genie Code:

```sh
dbx genie --model gpt "Summarize the changes since the latest release."
dbx genie --model claude -- exec --ephemeral "Review this repository."
```

Use `--` only when a wrapper option such as `--model` must be sent to Genie
instead of being consumed by `dbx genie`.

## Connect to Lakebase

```sh
dbx lakebase-proxy --profile MY-PROFILE --listen tcp://127.0.0.1:5432
```

Connect your PostgreSQL client to the loopback listener. The command reference
includes target selection, connection URLs, and service commands.

## Add memory or share an app

```sh
dbx graphiti --profile MY-PROFILE
dbx tunnel --allow example.com -- bun src/server.ts
```

`graphiti` provides graph memory for agents. `tunnel` adds a public URL with
passwordless access to an existing process.

## Export AppKit configuration

```sh
eval "$(dbx appkit env --quiet)"
```

Use the resolved AppKit environment before starting another process.

## Bootstrap a workspace

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

See [@dbx-tools/projen](../../../../projen) for workspace configuration and
generation. Command implementations are available from `@dbx-tools/cli/appkit`,
`/auth`, `/brand`, `/genie`, `/graphiti`, `/lakebase-proxy`, `/model-gateway`,
and `/tunnel` when a Node caller needs to embed one parser.

<!-- cli-reference:start -->

## Command reference

### `dbx`

Databricks developer tools: workspace lifecycle, AppKit env, auth, brand generation, tunnels, and local proxies

```sh
dbx [command]
```

#### Commands

| Command                          | Description                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `dev [projenArgs...]`            | Bootstrap or repair a dbx-tools workspace, then forward to projen                  |
| `appkit`                         | AppKit helpers: resolve the environment an AppKit app would start with.            |
| `auth [options]`                 | Authenticate to Databricks with user or machine OAuth                              |
| `brand [options] <prompt>`       | Research a brand brief and export brand.yaml with web and mobile visual references |
| `tunnel [options] [command...]`  | Front a command with a public tunnel and passwordless auth                         |
| `lakebase-proxy [options]`       | Run a loopback PostgreSQL proxy for Databricks Lakebase                            |
| `model-gateway [options]`        | Run or manage the AppKit Databricks model gateway                                  |
| `genie [options] [genieArgs...]` | Run Genie Code through an authenticated local Databricks model gateway             |
| `graphiti [options]`             | Run Graphiti or manage its current-user desktop service                            |

### `dbx dev`

Bootstrap or repair a dbx-tools workspace, then forward to projen

```sh
dbx dev [projenArgs...]
```

#### Arguments

| Argument     | Description                                         |
| ------------ | --------------------------------------------------- |
| `projenArgs` | Projen task and arguments, for example sync --watch |

### `dbx appkit`

AppKit helpers: resolve the environment an AppKit app would start with.

```sh
dbx appkit [command]
```

#### Commands

| Command         | Description                                            |
| --------------- | ------------------------------------------------------ |
| `env [options]` | Run AppKit auto-config and print new/changed env vars. |

### `dbx appkit env`

Run AppKit auto-config and print new/changed env vars.

```sh
dbx appkit env [options]
```

#### Options

| Option                 | Description                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `-f, --format <value>` | Output format: export, windows, or json. (choices: "export", "windows", "json", default: "export", env: FORMAT) |
| `-q, --quiet`          | Suppress auto-config log output. (default: false, env: QUIET)                                                   |
| `--no-quiet`           | Disable suppress auto-config log output.                                                                        |

### `dbx auth`

Authenticate to Databricks with user or machine OAuth

```sh
dbx auth [options] [command]
```

#### Options

| Option                            | Description                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--profile <value>`               | Databricks CLI profile. (env: DATABRICKS_CONFIG_PROFILE)                                                       |
| `-s, --scopes <value>`            | OAuth scopes. (default: [], env: SCOPES)                                                                       |
| `-t, --target <value>`            | OAuth target. (choices: "workspace", "account", "unified", env: TARGET)                                        |
| `--lock-timeout-ms <value>`       | Credential lock timeout in milliseconds. (default: 0, env: LOCK_TIMEOUT_MS)                                    |
| `--login-timeout-ms <value>`      | Browser login timeout in milliseconds. (default: 900000, env: LOGIN_TIMEOUT_MS)                                |
| `-r, --refresh-buffer-ms <value>` | Token refresh buffer in milliseconds. (default: 300000, env: REFRESH_BUFFER_MS)                                |
| `--prefer-user-to-machine`        | Prefer a matching user profile over selected machine credentials. (default: true, env: PREFER_USER_TO_MACHINE) |
| `--no-prefer-user-to-machine`     | Disable prefer a matching user profile over selected machine credentials.                                      |

#### Commands

| Command           | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `login`           | Force browser login and return an access token         |
| `token [options]` | Return a valid access token, logging in when needed    |
| `headers`         | Return current Databricks authentication headers       |
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

| Option               | Description                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--force-refresh`    | Refresh the token before returning it. (default: false, env: FORCE_REFRESH)                                        |
| `--no-force-refresh` | Disable refresh the token before returning it.                                                                     |
| `-l, --login`        | Log in when credentials are missing or invalid. (default: true, env: LOGIN)                                        |
| `--no-login`         | Disable log in when credentials are missing or invalid.                                                            |
| `--format <value>`   | Output structured token metadata or only the access token. (choices: "json", "text", default: "json", env: FORMAT) |

### `dbx auth headers`

Return current Databricks authentication headers

```sh
dbx auth headers
```

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

### `dbx brand`

Research a brand brief and export brand.yaml with web and mobile visual references

```sh
dbx brand [options] <prompt>
```

#### Arguments

| Argument | Description                                          |
| -------- | ---------------------------------------------------- |
| `prompt` | brand, company, product, or design brief to research |

#### Options

| Option                        | Description                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `-p, --profile <value>`       | Databricks CLI profile. (env: DATABRICKS_CONFIG_PROFILE)                                                                               |
| `-n, --name <value>`          | Known canonical brand name. (env: NAME)                                                                                                |
| `-w, --website <value>`       | Known official HTTPS website. (env: WEBSITE)                                                                                           |
| `-o, --output <value>`        | Persistent output directory for brand.yaml, showcase, provenance, and visual references. Omit for a temporary directory. (env: OUTPUT) |
| `--model <value>`             | Optional Databricks model preference for brand synthesis. (env: MODEL)                                                                 |
| `--max-sources <value>`       | Maximum general web sources to read. (default: 4, env: MAX_SOURCES)                                                                    |
| `--source-max-length <value>` | Maximum characters retained from each source page. (default: 8000, env: SOURCE_MAX_LENGTH)                                             |
| `--showcase`                  | Responsive HTML brand presentation and website mockups. (default: true, env: SHOWCASE)                                                 |
| `--no-showcase`               | Disable responsive html brand presentation and website mockups.                                                                        |
| `-f, --force`                 | Replace files in an existing output directory. (default: false, env: FORCE)                                                            |
| `--no-force`                  | Disable replace files in an existing output directory.                                                                                 |

### `dbx tunnel`

Front a command with a public tunnel and passwordless auth

```sh
dbx tunnel [options] [command] [command...]
```

#### Arguments

| Argument  | Description                     |
| --------- | ------------------------------- |
| `command` | the command to wrap, after `--` |

#### Options

| Option                           | Description                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `-t, --transport <value>`        | Public tunnel transport. (choices: "portr", "frp", "both", env: TUNNEL_TRANSPORT)               |
| `--public-domain <value>`        | Public tunnel domain. (env: TUNNEL_PUBLIC_DOMAIN)                                               |
| `--subdomain <value>`            | Portr subdomain. (env: SUBDOMAIN)                                                               |
| `--port <value>`                 | Public listener port. (env: DATABRICKS_APP_PORT)                                                |
| `--app-port <value>`             | Private wrapped application port. (env: TUNNEL_APP_PORT)                                        |
| `--allow <value>`                | Email allow-list patterns. (env: TUNNEL_AUTH_ALLOW)                                             |
| `--subject <value>`              | Verification email subject. (env: TUNNEL_AUTH_SUBJECT)                                          |
| `--brand-name <value>`           | Verification email brand name. (env: TUNNEL_AUTH_BRAND_NAME)                                    |
| `--passkey-name-prefix <value>`  | Prefix for humanized tunnel passkey names. (env: TUNNEL_AUTH_PASSKEY_NAME_PREFIX)               |
| `-m, --message <value>`          | Verification email message. (env: TUNNEL_AUTH_MESSAGE)                                          |
| `--session-ttl-seconds <value>`  | Session lifetime in seconds. (env: TUNNEL_AUTH_SESSION_TTL)                                     |
| `-c, --code-ttl-seconds <value>` | One-time-code lifetime in seconds. (env: TUNNEL_AUTH_CODE_TTL)                                  |
| `--session-cutoff <value>`       | Invalidate sessions issued before this value. (env: TUNNEL_AUTH_SESSION_CUTOFF)                 |
| `--storage <value>`              | Authentication database mode. (choices: "auto", "lakebase", "sqlite", env: TUNNEL_AUTH_STORAGE) |
| `--sqlite-path <value>`          | Local authentication SQLite file. (env: TUNNEL_AUTH_SQLITE_PATH)                                |
| `--forward-headers <value>`      | Additional forwarded request header patterns. (env: TUNNEL_FORWARD_HEADERS)                     |
| `-g, --gate-paths <value>`       | Additional path prefixes requiring authentication. (env: TUNNEL_GATE_PATHS)                     |
| `--bind-hosts <value>`           | Interface IPs the gate listens on. (env: BIND_HOSTS)                                            |
| `-i, --insecure`                 | Run without an authentication gate. (env: TUNNEL_INSECURE)                                      |
| `--no-insecure`                  | Disable run without an authentication gate.                                                     |
| `--frp-server <value>`           | FRP control host. (env: FRP_SERVER)                                                             |
| `--frp-public-domain <value>`    | FRP public HTTP domain. (env: TUNNEL_FRP_PUBLIC_DOMAIN)                                         |
| `--frp-server-port <value>`      | FRP control port. (env: FRP_SERVER_PORT)                                                        |
| `--frp-protocol <value>`         | FRP transport protocol. (env: FRP_PROTOCOL)                                                     |
| `--frp-token <value>`            | FRP authentication token. (env: FRP_TOKEN)                                                      |
| `--frp-proxy-name <value>`       | FRP proxy registration name. (env: FRP_PROXY_NAME)                                              |

#### Commands

| Command                      | Description                                    |
| ---------------------------- | ---------------------------------------------- |
| `run [options] <command...>` | Wrap a command (the default action)            |
| `status [options]`           | Resolve the configuration and print it         |
| `install [transport]`        | Install public tunnel client binaries and exit |

### `dbx tunnel run`

Wrap a command (the default action)

```sh
dbx tunnel run [options] <command...>
```

#### Arguments

| Argument  | Description                     |
| --------- | ------------------------------- |
| `command` | the command to wrap, after `--` |

#### Options

| Option                           | Description                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `-t, --transport <value>`        | Public tunnel transport. (choices: "portr", "frp", "both", env: TUNNEL_TRANSPORT)               |
| `--public-domain <value>`        | Public tunnel domain. (env: TUNNEL_PUBLIC_DOMAIN)                                               |
| `--subdomain <value>`            | Portr subdomain. (env: SUBDOMAIN)                                                               |
| `--port <value>`                 | Public listener port. (env: DATABRICKS_APP_PORT)                                                |
| `--app-port <value>`             | Private wrapped application port. (env: TUNNEL_APP_PORT)                                        |
| `--allow <value>`                | Email allow-list patterns. (env: TUNNEL_AUTH_ALLOW)                                             |
| `--subject <value>`              | Verification email subject. (env: TUNNEL_AUTH_SUBJECT)                                          |
| `--brand-name <value>`           | Verification email brand name. (env: TUNNEL_AUTH_BRAND_NAME)                                    |
| `--passkey-name-prefix <value>`  | Prefix for humanized tunnel passkey names. (env: TUNNEL_AUTH_PASSKEY_NAME_PREFIX)               |
| `-m, --message <value>`          | Verification email message. (env: TUNNEL_AUTH_MESSAGE)                                          |
| `--session-ttl-seconds <value>`  | Session lifetime in seconds. (env: TUNNEL_AUTH_SESSION_TTL)                                     |
| `-c, --code-ttl-seconds <value>` | One-time-code lifetime in seconds. (env: TUNNEL_AUTH_CODE_TTL)                                  |
| `--session-cutoff <value>`       | Invalidate sessions issued before this value. (env: TUNNEL_AUTH_SESSION_CUTOFF)                 |
| `--storage <value>`              | Authentication database mode. (choices: "auto", "lakebase", "sqlite", env: TUNNEL_AUTH_STORAGE) |
| `--sqlite-path <value>`          | Local authentication SQLite file. (env: TUNNEL_AUTH_SQLITE_PATH)                                |
| `--forward-headers <value>`      | Additional forwarded request header patterns. (env: TUNNEL_FORWARD_HEADERS)                     |
| `-g, --gate-paths <value>`       | Additional path prefixes requiring authentication. (env: TUNNEL_GATE_PATHS)                     |
| `--bind-hosts <value>`           | Interface IPs the gate listens on. (env: BIND_HOSTS)                                            |
| `-i, --insecure`                 | Run without an authentication gate. (env: TUNNEL_INSECURE)                                      |
| `--no-insecure`                  | Disable run without an authentication gate.                                                     |
| `--frp-server <value>`           | FRP control host. (env: FRP_SERVER)                                                             |
| `--frp-public-domain <value>`    | FRP public HTTP domain. (env: TUNNEL_FRP_PUBLIC_DOMAIN)                                         |
| `--frp-server-port <value>`      | FRP control port. (env: FRP_SERVER_PORT)                                                        |
| `--frp-protocol <value>`         | FRP transport protocol. (env: FRP_PROTOCOL)                                                     |
| `--frp-token <value>`            | FRP authentication token. (env: FRP_TOKEN)                                                      |
| `--frp-proxy-name <value>`       | FRP proxy registration name. (env: FRP_PROXY_NAME)                                              |

### `dbx tunnel status`

Resolve the configuration and print it

```sh
dbx tunnel status [options]
```

#### Options

| Option                           | Description                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `-t, --transport <value>`        | Public tunnel transport. (choices: "portr", "frp", "both", env: TUNNEL_TRANSPORT)               |
| `--public-domain <value>`        | Public tunnel domain. (env: TUNNEL_PUBLIC_DOMAIN)                                               |
| `--subdomain <value>`            | Portr subdomain. (env: SUBDOMAIN)                                                               |
| `--port <value>`                 | Public listener port. (env: DATABRICKS_APP_PORT)                                                |
| `--app-port <value>`             | Private wrapped application port. (env: TUNNEL_APP_PORT)                                        |
| `--allow <value>`                | Email allow-list patterns. (env: TUNNEL_AUTH_ALLOW)                                             |
| `--subject <value>`              | Verification email subject. (env: TUNNEL_AUTH_SUBJECT)                                          |
| `--brand-name <value>`           | Verification email brand name. (env: TUNNEL_AUTH_BRAND_NAME)                                    |
| `--passkey-name-prefix <value>`  | Prefix for humanized tunnel passkey names. (env: TUNNEL_AUTH_PASSKEY_NAME_PREFIX)               |
| `-m, --message <value>`          | Verification email message. (env: TUNNEL_AUTH_MESSAGE)                                          |
| `--session-ttl-seconds <value>`  | Session lifetime in seconds. (env: TUNNEL_AUTH_SESSION_TTL)                                     |
| `-c, --code-ttl-seconds <value>` | One-time-code lifetime in seconds. (env: TUNNEL_AUTH_CODE_TTL)                                  |
| `--session-cutoff <value>`       | Invalidate sessions issued before this value. (env: TUNNEL_AUTH_SESSION_CUTOFF)                 |
| `--storage <value>`              | Authentication database mode. (choices: "auto", "lakebase", "sqlite", env: TUNNEL_AUTH_STORAGE) |
| `--sqlite-path <value>`          | Local authentication SQLite file. (env: TUNNEL_AUTH_SQLITE_PATH)                                |
| `--forward-headers <value>`      | Additional forwarded request header patterns. (env: TUNNEL_FORWARD_HEADERS)                     |
| `-g, --gate-paths <value>`       | Additional path prefixes requiring authentication. (env: TUNNEL_GATE_PATHS)                     |
| `--bind-hosts <value>`           | Interface IPs the gate listens on. (env: BIND_HOSTS)                                            |
| `-i, --insecure`                 | Run without an authentication gate. (env: TUNNEL_INSECURE)                                      |
| `--no-insecure`                  | Disable run without an authentication gate.                                                     |
| `--frp-server <value>`           | FRP control host. (env: FRP_SERVER)                                                             |
| `--frp-public-domain <value>`    | FRP public HTTP domain. (env: TUNNEL_FRP_PUBLIC_DOMAIN)                                         |
| `--frp-server-port <value>`      | FRP control port. (env: FRP_SERVER_PORT)                                                        |
| `--frp-protocol <value>`         | FRP transport protocol. (env: FRP_PROTOCOL)                                                     |
| `--frp-token <value>`            | FRP authentication token. (env: FRP_TOKEN)                                                      |
| `--frp-proxy-name <value>`       | FRP proxy registration name. (env: FRP_PROXY_NAME)                                              |

### `dbx tunnel install`

Install public tunnel client binaries and exit

```sh
dbx tunnel install [transport]
```

#### Arguments

| Argument    | Description                            |
| ----------- | -------------------------------------- |
| `transport` | portr, frp, or both (default: "portr") |

### `dbx lakebase-proxy`

Run a loopback PostgreSQL proxy for Databricks Lakebase

```sh
dbx lakebase-proxy [options] [command]
```

#### Options

| Option                                  | Description                                                             |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `-V, --version`                         | output the version number                                               |
| `--postgres-role <value>`               | PostgreSQL role assumed after authentication. (env: POSTGRES_ROLE)      |
| `-l, --listen <value>`                  | Loopback listener address. (default: tcp://localhost:5432, env: LISTEN) |
| `-s, --startup-timeout-seconds <value>` | Startup timeout in seconds. (default: 30, env: STARTUP_TIMEOUT_SECONDS) |
| `--profile <value>`                     | Exact Databricks profile. (env: DATABRICKS_CONFIG_PROFILE)              |

#### Commands

| Command         | Description                                         |
| --------------- | --------------------------------------------------- |
| `url [options]` | Format a local PostgreSQL URL for a Lakebase target |
| `service`       | Install and manage the desktop service              |

### `dbx lakebase-proxy url`

Format a local PostgreSQL URL for a Lakebase target

```sh
dbx lakebase-proxy url [options]
```

#### Options

| Option                 | Description                                                       |
| ---------------------- | ----------------------------------------------------------------- |
| `-t, --target <value>` | Lakebase project, resource path, host, or URL. (env: TARGET)      |
| `--listen <value>`     | Local proxy address. (default: tcp://localhost:5432, env: LISTEN) |

### `dbx lakebase-proxy service`

Install and manage the desktop service

```sh
dbx lakebase-proxy service [command]
```

#### Commands

| Command             | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `install [options]` | Install the service for the current user and start it |
| `start`             | Start the installed service                           |
| `stop`              | Stop the running service                              |
| `restart`           | Restart the installed service                         |
| `status`            | Print service installation and process state as JSON  |
| `logs [command...]` | Print the service log path or append it to a command  |
| `uninstall`         | Stop and remove the service for the current user      |

### `dbx lakebase-proxy service install`

Install the service for the current user and start it

```sh
dbx lakebase-proxy service install [options]
```

#### Options

| Option                                  | Description                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `--start`                               | Start the service after installation. (default: true)                              |
| `--no-start`                            | Disable start the service after installation.                                      |
| `--python-project <value>`              | Local Python project installed instead of the registry package.                    |
| `--offline`                             | Install Python packages from the uv cache without network access. (default: false) |
| `--no-offline`                          | Disable install python packages from the uv cache without network access.          |
| `--postgres-role <value>`               | PostgreSQL role assumed after authentication. (env: POSTGRES_ROLE)                 |
| `-l, --listen <value>`                  | Loopback listener address. (default: tcp://localhost:5432, env: LISTEN)            |
| `-s, --startup-timeout-seconds <value>` | Startup timeout in seconds. (default: 30, env: STARTUP_TIMEOUT_SECONDS)            |
| `--profile <value>`                     | Exact Databricks profile. (env: DATABRICKS_CONFIG_PROFILE)                         |

### `dbx lakebase-proxy service start`

Start the installed service

```sh
dbx lakebase-proxy service start
```

### `dbx lakebase-proxy service stop`

Stop the running service

```sh
dbx lakebase-proxy service stop
```

### `dbx lakebase-proxy service restart`

Restart the installed service

```sh
dbx lakebase-proxy service restart
```

### `dbx lakebase-proxy service status`

Print service installation and process state as JSON

```sh
dbx lakebase-proxy service status
```

### `dbx lakebase-proxy service logs`

Print the service log path or append it to a command

```sh
dbx lakebase-proxy service logs [command...]
```

#### Arguments

| Argument  | Description                                              |
| --------- | -------------------------------------------------------- |
| `command` | Command and arguments to run before the service log path |

### `dbx lakebase-proxy service uninstall`

Stop and remove the service for the current user

```sh
dbx lakebase-proxy service uninstall
```

### `dbx model-gateway`

Run or manage the AppKit Databricks model gateway

```sh
dbx model-gateway [options] [command]
```

#### Options

| Option                                             | Description                                                                                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-v, --version`                                    | output the version number                                                                                                                                                  |
| `--model <value>`                                  | Optional fuzzy or exact model name. (env: MODEL)                                                                                                                           |
| `--model-class <value>`                            | Optional model capability class used when selecting a default model. (choices: "chat-thinking", "chat-balanced", "chat-fast", "embedding", env: MODEL_CLASS)               |
| `--smart-router <value>`                           | Smart Router mode: auto advertises it only when available, true requires it, and false disables it. (choices: "auto", "true", "false", default: "auto", env: SMART_ROUTER) |
| `--smart-router-timeout-ms <value>`                | Maximum milliseconds allowed for one Databricks Smart Router request. (default: 10000, env: SMART_ROUTER_TIMEOUT_MS)                                                       |
| `--smart-router-context-token-budget <value>`      | o200k_base token budget used to build Smart Router task context. (default: 4096, env: SMART_ROUTER_CONTEXT_TOKEN_BUDGET)                                                   |
| `--smart-router-probe-ttl-ms <value>`              | Milliseconds a successful memoized Smart Router capability probe remains valid. (default: 300000, env: SMART_ROUTER_PROBE_TTL_MS)                                          |
| `--smart-router-probe-refresh-interval-ms <value>` | Milliseconds between unref'd background refreshes of cached Smart Router probes. (default: 3600000, env: SMART_ROUTER_PROBE_REFRESH_INTERVAL_MS)                           |
| `--smart-router-route-ttl-seconds <value>`         | Seconds a logical turn remains pinned to its Smart Router-selected model. (default: 21600, env: SMART_ROUTER_ROUTE_TTL_SECONDS)                                            |
| `--prefer-system-models`                           | Prefer system.ai services over serving endpoints for non-exact model selection. (default: false, env: PREFER_SYSTEM_MODELS)                                                |
| `--no-prefer-system-models`                        | Disable prefer system.ai services over serving endpoints for non-exact model selection.                                                                                    |
| `-l, --listen <value>`                             | Loopback listener address. (default: tcp://localhost:4000, env: LISTEN)                                                                                                    |
| `--profile <value>`                                | Databricks profile used for model discovery and requests. (env: DATABRICKS_CONFIG_PROFILE)                                                                                 |
| `--body-limit <value>`                             | Maximum JSON request body size. (default: "100mb", env: BODY_LIMIT)                                                                                                        |
| `-r, --runtime-info`                               | Print runtime implementation metadata. (default: false, env: RUNTIME_INFO)                                                                                                 |
| `--no-runtime-info`                                | Disable print runtime implementation metadata.                                                                                                                             |
| `--select-model-from <value>`                      | Select a Smart Router model from a JSON or text file; use - for standard input. (env: SELECT_MODEL_FROM)                                                                   |

#### Commands

| Command   | Description                            |
| --------- | -------------------------------------- |
| `service` | Install and manage the desktop service |

### `dbx model-gateway service`

Install and manage the desktop service

```sh
dbx model-gateway service [command]
```

#### Commands

| Command             | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `install [options]` | Install the service for the current user and start it |
| `start`             | Start the installed service                           |
| `stop`              | Stop the running service                              |
| `restart`           | Restart the installed service                         |
| `status`            | Print service installation and process state as JSON  |
| `logs [command...]` | Print the service log path or append it to a command  |
| `uninstall`         | Stop and remove the service for the current user      |

### `dbx model-gateway service install`

Install the service for the current user and start it

```sh
dbx model-gateway service install [options]
```

#### Options

| Option                     | Description                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `--start`                  | Start the service after installation. (default: true)                              |
| `--no-start`               | Disable start the service after installation.                                      |
| `--python-project <value>` | Local Python project installed instead of the registry package.                    |
| `--offline`                | Install Python packages from the uv cache without network access. (default: false) |
| `--no-offline`             | Disable install python packages from the uv cache without network access.          |

### `dbx model-gateway service start`

Start the installed service

```sh
dbx model-gateway service start
```

### `dbx model-gateway service stop`

Stop the running service

```sh
dbx model-gateway service stop
```

### `dbx model-gateway service restart`

Restart the installed service

```sh
dbx model-gateway service restart
```

### `dbx model-gateway service status`

Print service installation and process state as JSON

```sh
dbx model-gateway service status
```

### `dbx model-gateway service logs`

Print the service log path or append it to a command

```sh
dbx model-gateway service logs [command...]
```

#### Arguments

| Argument  | Description                                              |
| --------- | -------------------------------------------------------- |
| `command` | Command and arguments to run before the service log path |

### `dbx model-gateway service uninstall`

Stop and remove the service for the current user

```sh
dbx model-gateway service uninstall
```

### `dbx genie`

Run Genie Code through an authenticated local Databricks model gateway

```sh
dbx genie [options] [genieArgs...]
```

#### Arguments

| Argument    | Description                                                                           |
| ----------- | ------------------------------------------------------------------------------------- |
| `genieArgs` | Arguments and unknown flags forwarded to Genie Code. Separate wrapper options with -- |

#### Options

| Option                         | Description                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `--model <value>`              | Optional fuzzy or exact model name. (env: MODEL)                                                                                               |
| `--model-class <value>`        | Optional chat capability class used when selecting a default model. (choices: "chat-thinking", "chat-balanced", "chat-fast", env: MODEL_CLASS) |
| `-p, --profile <value>`        | Databricks profile used by the model-gateway sidecar. (env: DATABRICKS_CONFIG_PROFILE)                                                         |
| `-g, --gateway-listen <value>` | Loopback listener allocated for the model-gateway sidecar. (default: tcp://127.0.0.1:0, env: GATEWAY_LISTEN)                                   |

### `dbx graphiti`

Run Graphiti or manage its current-user desktop service

```sh
dbx graphiti [options] [command]
```

#### Options

| Option                             | Description                                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-v, --version`                    | output the version number                                                                                                                                            |
| `--profile <value>`                | Databricks profile used for model discovery and authentication. (env: DATABRICKS_CONFIG_PROFILE)                                                                     |
| `-b, --bearer <value>`             | Optional bearer token required by every Graphiti HTTP endpoint. (env: GRAPHITI_TOKEN)                                                                                |
| `-g, --graphiti-home <value>`      | Application-owned Graphiti runtime directory. (env: GRAPHITI_HOME)                                                                                                   |
| `-m, --model-class <value>`        | Optional chat capability class used when selecting a default model. (choices: "chat-thinking", "chat-balanced", "chat-fast", default: "chat-fast", env: MODEL_CLASS) |
| `-t, --temperature <value>`        | Sampling temperature forwarded to the Graphiti LLM client. (default: 1, env: TEMPERATURE)                                                                            |
| `--structured-output-mode <value>` | Structured-output mode forwarded to Graphiti's OpenAI provider. (default: "json_object", env: LLM_STRUCTURED_OUTPUT_MODE)                                            |
| `--startup-timeout-ms <value>`     | Maximum milliseconds allowed for the Graphiti runtime to become ready. (default: 180000, env: GRAPHITI_STARTUP_TIMEOUT_MS)                                           |
| `-l, --listen <value>`             | Graphiti HTTP listener. (default: tcp://127.0.0.1:7272, env: GRAPHITI_LISTEN)                                                                                        |
| `--database-url <value>`           | PostgreSQL URL or Lakebase target. Omit it to use persistent embedded PostgreSQL. (env: LAKEBASE_ENDPOINT)                                                           |
| `--database-schema <value>`        | PostgreSQL schema used for Lakebase graph tables. (default: "dbx_tools_graphiti", env: GRAPHITI_DATABASE_SCHEMA)                                                     |
| `--postgres-role <value>`          | PostgreSQL role assumed after authentication. (env: POSTGRES_ROLE)                                                                                                   |

#### Commands

| Command   | Description                            |
| --------- | -------------------------------------- |
| `service` | Install and manage the desktop service |

### `dbx graphiti service`

Install and manage the desktop service

```sh
dbx graphiti service [command]
```

#### Commands

| Command             | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `install [options]` | Install the service for the current user and start it |
| `start`             | Start the installed service                           |
| `stop`              | Stop the running service                              |
| `restart`           | Restart the installed service                         |
| `status`            | Print service installation and process state as JSON  |
| `logs [command...]` | Print the service log path or append it to a command  |
| `uninstall`         | Stop and remove the service for the current user      |

### `dbx graphiti service install`

Install the service for the current user and start it

```sh
dbx graphiti service install [options]
```

#### Options

| Option                     | Description                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `--start`                  | Start the service after installation. (default: true)                              |
| `--no-start`               | Disable start the service after installation.                                      |
| `--python-project <value>` | Local Python project installed instead of the registry package.                    |
| `--offline`                | Install Python packages from the uv cache without network access. (default: false) |
| `--no-offline`             | Disable install python packages from the uv cache without network access.          |

### `dbx graphiti service start`

Start the installed service

```sh
dbx graphiti service start
```

### `dbx graphiti service stop`

Stop the running service

```sh
dbx graphiti service stop
```

### `dbx graphiti service restart`

Restart the installed service

```sh
dbx graphiti service restart
```

### `dbx graphiti service status`

Print service installation and process state as JSON

```sh
dbx graphiti service status
```

### `dbx graphiti service logs`

Print the service log path or append it to a command

```sh
dbx graphiti service logs [command...]
```

#### Arguments

| Argument  | Description                                              |
| --------- | -------------------------------------------------------- |
| `command` | Command and arguments to run before the service log path |

### `dbx graphiti service uninstall`

Stop and remove the service for the current user

```sh
dbx graphiti service uninstall
```

<!-- cli-reference:end -->
