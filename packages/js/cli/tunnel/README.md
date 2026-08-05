# @dbx-tools/cli-tunnel

Wrap any command in a public [portr](https://github.com/amalshaji/portr) tunnel
fronted by an email one-time-code gate.

Run `dbx tunnel -- <command>` when a local or self-hosted process needs a public
URL that only approved email addresses can reach. The wrapper claims the public
port, starts your command on a private loopback port, and reverse-proxies between
them so the gate sits in front of traffic the command itself never has to know
about.

Key features:

- Public portr tunnel + email-OTP gate around a command the wrapper does not
  have to modify, import, or even be written in the same language as.
- A reverse proxy that answers the login routes itself and forwards only
  verified traffic to the wrapped process.
- Flag → environment → `databricks.yml` resolution for every gate and portr
  setting, delegated to [`@dbx-tools/tunnel`](../../node/tunnel) so the CLI
  cannot drift from the in-process plugin.
- `status` to print exactly what would happen without starting anything.
- Two-way process supervision: a crashed child takes the tunnel down instead of
  leaving portr serving a dead port.
- Lazy loading, so `--insecure`, `status`, and `install` never load AppKit, the
  Databricks SDK, or the SMTP stack.

## Why Not The AppKit Plugin?

Use the in-process path when you can. An app that boots through
[`@dbx-tools/appkit`](../../node/appkit)'s `createApp` should register
`tunnelInterceptor()` plus the `authGate` plugin from
[`@dbx-tools/tunnel`](../../node/tunnel): one process, no proxy hop, no
duplicated header handling.

Use this wrapper for the case that path cannot cover:

- a project that does not call `appkit.createApp`, so there is no plugin
  lifecycle to register a gate in;
- a process that is not a Node/AppKit server at all - a Python service, a static
  file server, a third-party binary;
- a command you want gated without editing its source.

The gating DECISION is shared either way. The proxy calls `@dbx-tools/tunnel`'s
`gate.gateRequest` - the same function the Express middleware uses - so which
requests are gated and which headers are stripped has exactly one
implementation.

## Run A Tunnel

```sh
dbx tunnel --allow databricks.com -- bun src/server.ts
```

This package ships no bin. It contributes the `tunnel` command group to the
single `dbx` CLI in [`@dbx-tools/cli`](../dbx-tools), which is what you install:

```sh
npm install --global @dbx-tools/cli
dbx tunnel --help
```

`dbx` imports this package lazily, so `dbx dev` pays for none of it.

The command after `--` is spawned with `DATABRICKS_APP_PORT`, `PORT`, and
`HOST=127.0.0.1` pointing at a private port, so a server that honors those
variables needs no changes. `run` is both the default action and a named
subcommand, so `dbx tunnel -- cmd` and `dbx tunnel run -- cmd` are equivalent.

## Check What Would Happen

```sh
dbx tunnel status --allow databricks.com
```

The most common failure is a tunnel that silently does nothing because no portr
token or public domain resolved. `status` prints the fully resolved ports, gate
config, and portr config as JSON without starting a process.

```sh
dbx tunnel install
```

`install` downloads the portr binary and exits, so a first run does not pay for
the download.

## Commands And Flags

```
dbx tunnel [options] -- <command...>    # wrap a command (default)
dbx tunnel run [options] -- <command...>
dbx tunnel status [options]
dbx tunnel install
```

Every flag below is accepted on the root command and on `run` / `status`.
Omitted values fall back to the environment, a `.env` file, then
`databricks.yml`, through [`@dbx-tools/core`](../../node/core)'s `config`.

| Flag                          | Meaning                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| `--public-domain <host>`      | portr public domain (`<subdomain>.<server>`)               |
| `--subdomain <name>`          | portr subdomain, else derived from the public domain       |
| `--port <port>`               | public port the wrapper listens on (`DATABRICKS_APP_PORT`) |
| `--app-port <port>`           | private port the wrapped app binds, else a free one        |
| `--allow <patterns...>`       | email allow-list (domain, glob, or `/regex/`)              |
| `--subject <text>`            | verification email subject                                 |
| `--brand-name <name>`         | verification email brand name                              |
| `--message <text>`            | verification email message                                 |
| `--session-ttl <seconds>`     | session lifetime                                           |
| `--code-ttl <seconds>`        | one-time-code lifetime                                     |
| `--session-cutoff <when>`     | invalidate every session issued before this                |
| `--forward-headers <pats...>` | extra `x-` headers tunnel traffic may forward              |
| `--insecure`                  | run open, with no gate                                     |

Leave `--subject` and `--brand-name` alone unless you have a reason: the
defaults are the conventional one-time-code wording that iOS, Gmail, Outlook,
and Android detect for autofill, and a novel subject breaks that.

`--insecure` serves the tunnel with no gate at all and logs a warning. It is for
local debugging, not for anything reachable.

## How A Request Flows

1. The wrapper binds the PUBLIC port - the one portr and the Databricks Apps
   runtime route to - and spawns the command on a private loopback port.
2. A login route (`/auth/*`) is answered by the proxy itself, using the gate
   handlers from a server-less AppKit app that supplies the code store, signing
   key, and email transport.
3. Anything else goes through `gate.gateRequest`. A verified session is proxied
   to the child with caller-supplied `x-` headers stripped; an unverified
   request gets the login page or a `401`.
4. portr publishes the public port once a token and domain resolve. Without
   them the wrapper still serves locally and says so.

## Modules

- `cli` - the `dbx tunnel` commander program: `buildProgram(name?)`, which
  `@dbx-tools/cli` mounts.
- `options` - `resolveTunnelOptions()`, flag → config → default resolution.
- `proxy` - `startProxy()`, the gate-aware reverse proxy.
- `app` - `startGateApp()`, the server-less AppKit app behind the gate.

Gate behavior, portr lifecycle, and header policy live in
[`@dbx-tools/tunnel`](../../node/tunnel); email delivery in
[`@dbx-tools/email`](../../node/email).
