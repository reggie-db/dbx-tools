# @dbx-tools/cli-tunnel

Share an existing local process through a public Portr or FRP URL protected by
email one-time codes and passkeys. Approved users can reach your app without
adding authentication or tunnel handling to the wrapped process.

## Share A Local App

Install the [`dbx` CLI](../dbx-tools), configure a Portr token and public domain,
and configure email delivery as described in the
[tunnel guide](../../node/tunnel):

```sh
export PORTR_TOKEN=YOUR-TOKEN
export TUNNEL_PUBLIC_DOMAIN=demo.example.com
dbx tunnel --allow example.com -- bun src/server.ts
```

The wrapper gives your process a private loopback port through `PORT` and
`DATABRICKS_APP_PORT`, with `HOST=127.0.0.1`. Your process must honor those
variables. The wrapper exposes the public listener and handles sign-in before
forwarding protected requests.

`dbx tunnel run -- <command>` and `dbx tunnel -- <command>` are equivalent.
Arguments after `--` belong to your command, not to the tunnel CLI.

## Choose Access Rules

```sh
dbx tunnel --allow example.com --allow trusted@example.org --gate-paths /ws -- bun src/server.ts
```

Allow-list entries accept domains, glob patterns, and regular expressions. API
routes are gated by default; add other protected prefixes with `--gate-paths`.
`--insecure` disables the gate entirely.

Session lifetime, one-time-code lifetime, email wording, and authentication
storage can be set with the options in the generated reference. Use
`--session-cutoff` when you need to invalidate previously issued sessions.

## Inspect Configuration Before Starting

```sh
dbx tunnel status --allow example.com
```

`status` prints resolved ports, access rules, and tunnel configuration as JSON
without starting your process. Use it to check a missing token, domain, or
unexpected port before troubleshooting the wrapped app.

## Use FRP Or Prepare Clients

```sh
dbx tunnel --transport frp --frp-server frp.example.com --frp-public-domain demo.example.com --allow example.com -- bun src/server.ts
dbx tunnel install portr
dbx tunnel install frp
dbx tunnel install both
```

Choose `both` as the transport to expose Portr and FRP entrances together.
`install` prepares client executables without starting an application; it is
not a desktop-service installation.

## Use An AppKit Application

For an app that already starts through AppKit, use
[`@dbx-tools/tunnel`](../../node/tunnel)'s `tunnelInterceptor()` and `authGate`
plugin instead. They provide the same public access features within the app's
lifecycle. This CLI wrapper is useful for other frameworks, third-party
executables, and applications you do not want to modify.

<!-- cli-reference:start -->

## Command Reference

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
dbx tunnel run [options] <command...>
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
dbx tunnel status [options]
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
dbx tunnel install [transport]
```

#### Arguments

| Argument    | Description                            |
| ----------- | -------------------------------------- |
| `transport` | portr, frp, or both (default: "portr") |

<!-- cli-reference:end -->
