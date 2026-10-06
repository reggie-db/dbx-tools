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

Point an OpenAI-compatible client at `http://127.0.0.1:4000/v1`. See
[model gateway](../model-gateway#command-reference) for all options and desktop
service commands.

## Connect To Lakebase

```sh
dbx lakebase-proxy --profile MY-PROFILE --port 5432
```

Connect your PostgreSQL client to the loopback listener. See
[Lakebase proxy](../lakebase-proxy#command-reference) for target selection,
connection URLs, and service commands.

## Add Memory Or Share An App

```sh
dbx graphiti --profile MY-PROFILE
dbx tunnel --allow example.com -- bun src/server.ts
```

[Graphiti](../graphiti#command-reference) provides graph memory for agents.
[Tunnel](../tunnel#command-reference) adds a public URL with passwordless access
to an existing process. Each guide includes setup requirements and a generated
command reference.

## Export AppKit Configuration

```sh
eval "$(dbx appkit env --quiet)"
```

Use the resolved AppKit environment before starting another process. See
[AppKit environment](../appkit-env#command-reference) for JSON and Windows
output, and [authentication](../auth#command-reference) for token commands.

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
bun run openapi
```

See [`@dbx-tools/projen`](../../../../projen) for workspace configuration and
generation. The command reference below lists the top-level groups; each linked
package guide documents that group's complete options and subcommands.

<!-- cli-reference:start -->

## Command Reference

### `dbx`

Databricks developer tools: workspace lifecycle, AppKit env, auth, tunnels, and local proxies

```sh
dbx [command]
```

#### Commands

| Command                    | Description                                                        |
| -------------------------- | ------------------------------------------------------------------ |
| `dev [projenArgs...]`      | Bootstrap or repair a dbx-tools workspace, then forward to projen  |
| `appkit [args...]`         | AppKit helpers (env: print the environment an AppKit app resolves) |
| `auth [args...]`           | Authenticate to Databricks and manage OAuth tokens                 |
| `tunnel [args...]`         | Run a public portr tunnel with an email-OTP gate                   |
| `falkor-db [args...]`      | Run embedded FalkorDB with optional Databricks Volume backups      |
| `lakebase-proxy [args...]` | Run the Node Databricks Lakebase PostgreSQL proxy                  |
| `model-gateway [args...]`  | Run the foreground AppKit Databricks model gateway                 |
| `graphiti [args...]`       | Run Graphiti or manage its current-user desktop service            |

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

AppKit helpers (env: print the environment an AppKit app resolves)

```sh
dbx appkit [args...]
```

#### Arguments

| Argument | Description                   |
| -------- | ----------------------------- |
| `args`   | arguments forwarded to appkit |

### `dbx auth`

Authenticate to Databricks and manage OAuth tokens

```sh
dbx auth [args...]
```

#### Arguments

| Argument | Description                 |
| -------- | --------------------------- |
| `args`   | arguments forwarded to auth |

### `dbx tunnel`

Run a public portr tunnel with an email-OTP gate

```sh
dbx tunnel [args...]
```

#### Arguments

| Argument | Description                   |
| -------- | ----------------------------- |
| `args`   | arguments forwarded to tunnel |

### `dbx falkor-db`

Run embedded FalkorDB with optional Databricks Volume backups

```sh
dbx falkor-db [args...]
```

#### Arguments

| Argument | Description                      |
| -------- | -------------------------------- |
| `args`   | arguments forwarded to falkor-db |

### `dbx lakebase-proxy`

Run the Node Databricks Lakebase PostgreSQL proxy

```sh
dbx lakebase-proxy [args...]
```

#### Arguments

| Argument | Description                           |
| -------- | ------------------------------------- |
| `args`   | arguments forwarded to lakebase-proxy |

### `dbx model-gateway`

Run the foreground AppKit Databricks model gateway

```sh
dbx model-gateway [args...]
```

#### Arguments

| Argument | Description                          |
| -------- | ------------------------------------ |
| `args`   | arguments forwarded to model-gateway |

### `dbx graphiti`

Run Graphiti or manage its current-user desktop service

```sh
dbx graphiti [args...]
```

#### Arguments

| Argument | Description                     |
| -------- | ------------------------------- |
| `args`   | arguments forwarded to graphiti |

<!-- cli-reference:end -->
