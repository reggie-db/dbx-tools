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
dbx tunnel --allow example.com trusted@example.org --gate-path /ws -- bun src/server.ts
```

Allow-list entries accept domains, glob patterns, and regular expressions. API
routes are gated by default; add other protected prefixes with `--gate-path`.
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

| Option                            | Description                                           |
| --------------------------------- | ----------------------------------------------------- |
| `--transport <transport>`         | public tunnel transport: portr, frp, or both          |
| `--public-domain <host>`          | public tunnel domain                                  |
| `--subdomain <name>`              | portr subdomain (else derived from the public domain) |
| `--port <port>`                   | public port the wrapper listens on                    |
| `--app-port <port>`               | private port the wrapped app is told to bind          |
| `--allow <patterns...>`           | email allow-list (domain / glob / /regex/)            |
| `--subject <text>`                | verification email subject                            |
| `--brand-name <name>`             | verification email brand name                         |
| `--message <text>`                | verification email message                            |
| `--session-ttl <seconds>`         | session lifetime                                      |
| `--code-ttl <seconds>`            | one-time-code lifetime                                |
| `--session-cutoff <when>`         | invalidate every session issued before this           |
| `--auth-storage <mode>`           | auth database: auto, lakebase, or sqlite              |
| `--auth-sqlite-path <path>`       | local Better Auth SQLite file                         |
| `--forward-headers <patterns...>` | extra x- headers tunnel traffic may forward           |
| `--gate-path <prefix...>`         | path prefixes to gate beyond /api/ (e.g. /ws)         |
| `--bind <host...>`                | interface IPs the gate listens on (default: 0.0.0.0)  |
| `--frp-server <host>`             | frps control host (default: FRP public domain)        |
| `--frp-public-domain <host>`      | FRP public HTTP domain                                |
| `--frp-server-port <port>`        | frps control port (default: 443)                      |
| `--frp-protocol <protocol>`       | frpc transport protocol (default: wss)                |
| `--frp-token <token>`             | frps auth token                                       |
| `--frp-proxy-name <name>`         | frp proxy registration name                           |
| `--insecure`                      | run open, with no gate                                |

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

| Option                            | Description                                           |
| --------------------------------- | ----------------------------------------------------- |
| `--transport <transport>`         | public tunnel transport: portr, frp, or both          |
| `--public-domain <host>`          | public tunnel domain                                  |
| `--subdomain <name>`              | portr subdomain (else derived from the public domain) |
| `--port <port>`                   | public port the wrapper listens on                    |
| `--app-port <port>`               | private port the wrapped app is told to bind          |
| `--allow <patterns...>`           | email allow-list (domain / glob / /regex/)            |
| `--subject <text>`                | verification email subject                            |
| `--brand-name <name>`             | verification email brand name                         |
| `--message <text>`                | verification email message                            |
| `--session-ttl <seconds>`         | session lifetime                                      |
| `--code-ttl <seconds>`            | one-time-code lifetime                                |
| `--session-cutoff <when>`         | invalidate every session issued before this           |
| `--auth-storage <mode>`           | auth database: auto, lakebase, or sqlite              |
| `--auth-sqlite-path <path>`       | local Better Auth SQLite file                         |
| `--forward-headers <patterns...>` | extra x- headers tunnel traffic may forward           |
| `--gate-path <prefix...>`         | path prefixes to gate beyond /api/ (e.g. /ws)         |
| `--bind <host...>`                | interface IPs the gate listens on (default: 0.0.0.0)  |
| `--frp-server <host>`             | frps control host (default: FRP public domain)        |
| `--frp-public-domain <host>`      | FRP public HTTP domain                                |
| `--frp-server-port <port>`        | frps control port (default: 443)                      |
| `--frp-protocol <protocol>`       | frpc transport protocol (default: wss)                |
| `--frp-token <token>`             | frps auth token                                       |
| `--frp-proxy-name <name>`         | frp proxy registration name                           |
| `--insecure`                      | run open, with no gate                                |

### `dbx tunnel status`

Resolve the configuration and print it

```sh
dbx tunnel status [options]
```

#### Options

| Option                            | Description                                           |
| --------------------------------- | ----------------------------------------------------- |
| `--transport <transport>`         | public tunnel transport: portr, frp, or both          |
| `--public-domain <host>`          | public tunnel domain                                  |
| `--subdomain <name>`              | portr subdomain (else derived from the public domain) |
| `--port <port>`                   | public port the wrapper listens on                    |
| `--app-port <port>`               | private port the wrapped app is told to bind          |
| `--allow <patterns...>`           | email allow-list (domain / glob / /regex/)            |
| `--subject <text>`                | verification email subject                            |
| `--brand-name <name>`             | verification email brand name                         |
| `--message <text>`                | verification email message                            |
| `--session-ttl <seconds>`         | session lifetime                                      |
| `--code-ttl <seconds>`            | one-time-code lifetime                                |
| `--session-cutoff <when>`         | invalidate every session issued before this           |
| `--auth-storage <mode>`           | auth database: auto, lakebase, or sqlite              |
| `--auth-sqlite-path <path>`       | local Better Auth SQLite file                         |
| `--forward-headers <patterns...>` | extra x- headers tunnel traffic may forward           |
| `--gate-path <prefix...>`         | path prefixes to gate beyond /api/ (e.g. /ws)         |
| `--bind <host...>`                | interface IPs the gate listens on (default: 0.0.0.0)  |
| `--frp-server <host>`             | frps control host (default: FRP public domain)        |
| `--frp-public-domain <host>`      | FRP public HTTP domain                                |
| `--frp-server-port <port>`        | frps control port (default: 443)                      |
| `--frp-protocol <protocol>`       | frpc transport protocol (default: wss)                |
| `--frp-token <token>`             | frps auth token                                       |
| `--frp-proxy-name <name>`         | frp proxy registration name                           |
| `--insecure`                      | run open, with no gate                                |

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
