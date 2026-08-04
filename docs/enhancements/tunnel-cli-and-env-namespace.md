# Reusable tunnel CLI, optional AppKit, and a `DBX_TOOLS_` env namespace

Date: 2026-08-04

Status: proposed.

## Purpose

Three related changes, in the order they should be implemented:

1. Bring back a **wrapper tunnel CLI** so a public portr tunnel + email-OTP gate can front an
   app in a project that does not use `@dbx-tools/appkit`'s `createApp`. The in-process
   AppKit plugin stays the preferred path.
2. Make heavy dependencies **optional where a lazy boundary already exists**, so a `dbx`
   command never pays for a dependency it does not use.
3. Give every dbx-tools-owned environment variable one prefix, **`DBX_TOOLS_`**, keeping
   generic and third-party names alone, with deprecated aliases so nothing breaks.

## Background: what was removed

`packages/cli/tunnel` (`@dbx-tools/cli-tunnel`, bins `dbx-tools-tunnel` / `dbxt-tunnel`) was
deleted in `cdc8e0a` ("move to @dbx-tools/tunnel library consumed via createApp interceptor")
and the reverse-proxy `src/proxy.ts` went in `42133e2` ("gate public traffic in the app
server"). The wrapper spawned the real app on a random private port, booted a server-less
AppKit app for the gate, proxied the public port through `http-proxy-3`, and launched portr.

What replaced it is strictly better _for an AppKit app_: `tunnelInterceptor()` plus the
`authGate` plugin run in-process, so there is no second process, no proxy hop, and no
duplicated header handling. The regression is only for **non-AppKit projects**, which now
have no entry point at all. That is the gap to close, without regressing the plugin path.

## Part 1: `dbx tunnel`

### Shape

A new package, `packages/js/cli/tunnel` -> `@dbx-tools/cli-tunnel`, `cli`-tagged, **no bin**.
It exports `buildProgram(name?)`, which `@dbx-tools/cli` mounts as `dbx tunnel` through the
existing `addForwardedCommand` in `packages/js/cli/dbx-tools/src/cli.ts:72`. This is exactly
how `model-proxy` and `appkit` are mounted, so the command loads lazily and `dbx dev` still
pays for none of it.

Do not restore the old `dbx-tools-tunnel` / `dbxt-tunnel` bins. `@dbx-tools/cli` is the repo's
only bin, and that stays true.

A separate package rather than code inside `@dbx-tools/cli`, because the wrapper needs
`http-proxy-3` and (transitively) the gate's dependency set, and the lazy mount is what keeps
those off the `dbx dev` path.

### Commands

```
dbx tunnel run [options] -- <command...>    # wrap a command (default; `run` is optional)
dbx tunnel status [options]                 # resolve config and print what would happen
dbx tunnel install [options]                # install the portr binary only
```

`run` as the default action preserves the old ergonomics (`dbxt-tunnel --allow x -- bun
src/server.ts`) while giving `status` and `install` somewhere to live. `status` is worth having:
the most common failure is a tunnel that silently does nothing because no token or domain
resolved, and today the only way to see that is to read a log line.

### Options, and their env mapping

Every option resolves flag -> env -> default, through `env.string` / `env.positiveInt` /
`env.boolean` / `env.list` from `@dbx-tools/shared-core`, so the CLI and the plugin cannot
drift. Reuse the `*_ENV` constants already exported from
`packages/js/node/tunnel/src/env.ts:35` rather than restating names in the CLI.

| Flag                           | Env                                    | Default                        |
| ------------------------------ | -------------------------------------- | ------------------------------ |
| `--public-domain <host>`       | `DBX_TOOLS_TUNNEL_PUBLIC_DOMAIN`       | - (no tunnel)                  |
| `--subdomain <name>`           | -                                      | derived from the public domain |
| `--port <port>`                | `DATABRICKS_APP_PORT`                  | `8000`                         |
| `--app-port <port>`            | `DBX_TOOLS_TUNNEL_APP_PORT`            | random ephemeral               |
| `--allow <patterns>`           | `DBX_TOOLS_TUNNEL_AUTH_ALLOW`          | empty (nobody)                 |
| `--subject <text>`             | `DBX_TOOLS_TUNNEL_AUTH_SUBJECT`        | `Your verification code`       |
| `--brand-name <name>`          | `DBX_TOOLS_TUNNEL_AUTH_BRAND_NAME`     | brand context name             |
| `--message <text>`             | `DBX_TOOLS_TUNNEL_AUTH_MESSAGE`        | `Your verification code is:`   |
| `--session-ttl <seconds>`      | `DBX_TOOLS_TUNNEL_AUTH_SESSION_TTL`    | `2592000`                      |
| `--code-ttl <seconds>`         | `DBX_TOOLS_TUNNEL_AUTH_CODE_TTL`       | `600`                          |
| `--session-cutoff <when>`      | `DBX_TOOLS_TUNNEL_AUTH_SESSION_CUTOFF` | unset                          |
| `--forward-headers <patterns>` | `DBX_TOOLS_TUNNEL_FORWARD_HEADERS`     | built-in `x-` list             |
| `--insecure`                   | `DBX_TOOLS_TUNNEL_INSECURE`            | `false`                        |

`--app-port` is new and earns its place: the old CLI always picked a random private port, which
makes a wrapped app's own logs and any host-side tooling unpredictable. Keep random as the
default, allow pinning.

`PORTR_TOKEN` / `PORTR_SERVER` are **not** renamed - see the exclusion list in Part 3.

### Sharing code with the plugin, not forking it

The wrapper must not reimplement the gate. Extract the deleted `app.ts` + `proxy.ts` behavior
into the CLI package and have it consume `@dbx-tools/tunnel`'s existing exports:

- `resolvePortrConfig` / `installPortr` / `writePortrConfig` / `startPortr` from
  `packages/js/node/tunnel/src/portr.ts:48` - unchanged, already CLI-shaped.
- `AuthGatePlugin` / `authGate` and `resolveAuthGateConfig` from
  `packages/js/node/tunnel/src/plugin.ts` - the wrapper boots a server-less `createApp` to get
  the `AuthGateApi`, exactly as the deleted `app.ts` did (recover it with `git show
42133e2^:packages/node/tunnel/src/app.ts`, and the old CLI with `git show
cdc8e0a^:packages/cli/tunnel/src/cli.ts`).
- `CodeStore`, `RateLimiter`, `signingKey`, `matchesAllowlist`, `toHeaderPolicy` - all already
  exported from the package index.

The one genuinely new code is the reverse proxy, since `src/proxy.ts` was deleted when the gate
became Express middleware. Recover it with `git show 42133e2^:packages/node/tunnel/src/proxy.ts`
(the pre-`packages/js` layout) and adapt it, keeping these properties, each of which was
load-bearing:

- gate **loopback** traffic only, and forward non-loopback (platform front door) untouched;
- answer `/api/email/auth/*` in-process, since the wrapped app has no such routes;
- apply the inbound header policy to tunnel traffic, especially deleting
  `token.ACCESS_TOKEN_HEADER` - an app running `identity: "auto"` treats it as proof of OBO;
- inject `token.USER_ID_HEADER` / `USER_EMAIL_HEADER` for a verified session and strip the gate
  cookie, so the app sees a front-door-shaped request;
- let non-`/api/` paths through so the SPA and `<AuthGate>` can render;
- forward WebSocket upgrades with the same rules;
- `xfwd: true` so `x-forwarded-*` reflect the real socket rather than the caller's claim.

The proxy belongs in the CLI package, not in `@dbx-tools/tunnel`. It exists only because a
wrapped process cannot be given middleware, so putting it in the library would add `http-proxy-3`
to every app that just wants the plugin.

### Supervision

Keep the old `killOthers` behavior: the app child, the portr child, and the CLI process live and
die together, with `SIGTERM` to children and a bounded grace period before exit. `@dbx-tools/core`'s
`exec.spawn` already returns a `ChildProcess` that is also a `Promise<ExecResult>` (added in the
same commit that deleted the CLI), so use it rather than raw `node:child_process`.

### Documentation

Add `packages/js/cli/tunnel/README.md` in the standard shape, and give
`packages/js/node/tunnel/README.md` a short section pointing at it - stating plainly that the
plugin is preferred and the CLI is for apps that do not call `createApp`. Add the package to the
root README table and a Layout bullet in `AGENTS.md`.

## Part 2: optional dependencies

The goal is that a `dbx` subcommand loads only what it uses. It is **not** to purge AppKit from
`@dbx-tools/tunnel`; where the tunnel genuinely needs AppKit throughout, a hard dependency is
correct. Only take the wins where a lazy boundary already exists.

### Already correct, leave alone

- `@dbx-tools/cli`'s three subcommands are `await import()`ed, so `dbx dev` loads no SDK.
- `@dbx-tools/tunnel` -> `@dbx-tools/email` is an optional peer, imported lazily in
  `send-code.ts`.
- `@dbx-tools/appkit` and `@dbx-tools/genie` already make `@databricks/appkit` an optional peer.

### AppKit in `@dbx-tools/tunnel`: hard dependency, and that is fine

Worth stating explicitly so this is not revisited: AppKit is used across the package, not at one
edge - `Plugin` / `toPlugin` / `PluginManifest` in `src/plugin.ts:19`, and
`CacheManager.getInstanceSync()` in `src/otp.ts:22` and `src/signing-key.ts:46`. The plugin _is_
an AppKit plugin, and the OTP store and signing key depend on AppKit's cache for the durability
the README promises. Making that optional would mean a second storage backend, which is a real
feature, not a packaging tweak. **Keep `@databricks/appkit` and `@dbx-tools/appkit` as hard
dependencies of `@dbx-tools/tunnel`.**

The lazy boundary that _is_ free is in the new CLI: `dbx tunnel install` and `dbx tunnel status`
only need `./portr.ts`, so import the gate-booting module inside the `run` action rather than at
module top level. Then `dbx tunnel install` on a fresh machine never loads AppKit, the SDK, or a
mail transport. That is the whole win, and it costs one `await import()`.

### Two other candidates worth doing

- **`undici` in `cli-model-proxy`.** `src/server.ts:42` imports `Agent` and constructs
  `upstreamDispatcher` at module scope (`src/server.ts:67`), and `src/cli.ts:34` imports that
  module statically - so `dbx model-proxy models` and `resolve` both pay for undici and build a
  dispatcher they never use. Defer `./server.ts` into the serve and chat actions. Small, real, and
  the dispatcher-at-module-scope pattern is worth keeping (one shared agent), just not eagerly.
- **`@clack/prompts` in `@dbx-tools/cli`.** Used only by `src/bootstrap.ts:9`, which `src/cli.ts:28`
  imports statically. Since bootstrap is on the `dev` path anyway, the win here is narrower than
  it looks: it only helps `dbx tunnel` / `model-proxy` / `appkit`. Do it if `./bootstrap.ts` can be
  deferred into the `dev` action without contorting `prepareAndRunProjen`; skip it otherwise.

Do not chase anything past that. A dependency that is genuinely used on the command's own path
should be a plain dependency.

## Part 3: one env namespace

### The rule

A variable this repository invents is prefixed `DBX_TOOLS_`. A variable that is generic,
platform-defined, or another tool's contract keeps its name.

Today there are seven private namespaces (`TUNNEL_`, `TEAMS_`, `WEB_SEARCH_`, `SEARCH_`,
`EMAIL_`, `MASTRA_`, `PROXY_`) and one of them, `PROXY_`, is close to unforgivable in a shared
process environment: `PROXY_API_KEY` and `PROXY_RETRY_MAX` read like they configure an HTTP
proxy. `SEARCH_INDEX` and `EMAIL_FROM` are similarly generic enough to collide with the app
being wrapped or deployed alongside.

The prefix earns its keep for the same reason the tunnel's own README already argues for
`TUNNEL_`: these packages share one environment with someone else's app. `DBX_TOOLS_` extends
that argument to its conclusion - one namespace, not seven.

### Keep unprefixed (explicitly)

- **Databricks platform and SDK**: `DATABRICKS_*` (`DATABRICKS_APP_PORT`, `DATABRICKS_HOST`,
  `DATABRICKS_CLIENT_ID`, `DATABRICKS_CONFIG_PROFILE`, `DATABRICKS_WAREHOUSE_ID`,
  `DATABRICKS_SERVING_ENDPOINT_NAME`, `DATABRICKS_GENIE_SPACE_ID`, `DATABRICKS_VECTOR_SEARCH_*`).
  The platform or the SDK sets these; renaming them would rename someone else's contract.
- **Postgres**: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGSSLMODE`. libpq's namespace, and
  `createLakebasePool` reads them directly.
- **Ecosystem conventions**: `NODE_ENV`, `LOG_LEVEL`, `PYTHON_ENV`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OPENAI_API_KEY` / `OPENAI_BASE_URL`, `UV_*`, `PIP_*`, `npm_*`.
- **Third-party binaries**: `PORTR_TOKEN`, `PORTR_SERVER`, `PORTR_AUTO_ADD_PATH`.
- **Foreign-system credentials**: `MICROSOFT_APP_ID` / `MICROSOFT_APP_PASSWORD` /
  `MICROSOFT_APP_TENANT_ID`, which stay as the deprecated aliases they already are, because
  Azure's own docs name them.
- **SMTP**: `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_SECURE`. Debatable,
  but these are a de facto standard an operator already knows, and the credentials are the mail
  server's, not ours. Prefix the _policy_ (`EMAIL_*`), not the transport.
- **`LAKEBASE_ENDPOINT`**, which comes from a Databricks App `postgres` resource binding.

### Rename (primary name; old name becomes a deprecated alias)

| Current                                                                                                                                                     | New                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `TUNNEL_*` (11 vars)                                                                                                                                        | `DBX_TOOLS_TUNNEL_*`              |
| `TEAMS_CARD_VERSION`, `TEAMS_WEBHOOK_URL`, `TEAMS_AGENT_PLUGIN`, `TEAMS_ALLOW_UNAUTHENTICATED`, `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_APP_TENANT_ID` | `DBX_TOOLS_TEAMS_*`               |
| `WEB_SEARCH_*` (10 vars)                                                                                                                                    | `DBX_TOOLS_WEB_SEARCH_*`          |
| `SEARCH_*` (8 vars)                                                                                                                                         | `DBX_TOOLS_SEARCH_*`              |
| `EMAIL_DOMAIN`, `EMAIL_FROM`, `EMAIL_SYSTEM_FROM`, `EMAIL_ALLOWED_SENDERS`, `EMAIL_SENDER_POLICY`, `EMAIL_OUTBOX_MODE`, `EMAIL_OUTBOX_DIR`                  | `DBX_TOOLS_EMAIL_*`               |
| `MASTRA_GENIE_IDENTITY`                                                                                                                                     | `DBX_TOOLS_MASTRA_GENIE_IDENTITY` |
| `PROXY_API_KEY`, `PROXY_CHAT_CLIENT`, `PROXY_DROP_FIELDS`, `PROXY_RETRY_ON_429`, `PROXY_RETRY_MAX`, `PROXY_RETRY_BASE_MS`, `PROXY_RETRY_MAX_MS`             | `DBX_TOOLS_MODEL_PROXY_*`         |

`PROXY_*` becomes `DBX_TOOLS_MODEL_PROXY_*` rather than `DBX_TOOLS_PROXY_*`, matching the command
name (`dbx model-proxy`) so the variable and the command are searchable together.

Also fold the existing legacy aliases in: `EMAIL_AUTH_ALLOW`, `AUTH_SUBJECT`, `AUTH_BRAND_NAME`,
`AUTH_MESSAGE`, `AUTH_SESSION_TTL`, `AUTH_CODE_TTL`, `AUTH_JWT_SECRET`, `PUBLIC_DOMAIN`, and
`TUNNEL_AUTH_SESSION_EPOCH` all stay readable, now as the _third_ name in the list rather than
the second.

### Mechanism

`env.text` already takes an `EnvKey` list and is earliest-wins
(`packages/js/shared/core/src/env.ts:88`), so a rename is a one-line list change per variable and
**no consumer breaks**:

```ts
export const ALLOW_ENV: EnvKey = [
  "DBX_TOOLS_TUNNEL_AUTH_ALLOW",
  "TUNNEL_AUTH_ALLOW",
  "EMAIL_AUTH_ALLOW",
];
```

Two supporting changes make the migration visible and enforceable:

1. **A deprecation warning.** Add `env.deprecated(keys)` (or have `text` log once per key) that
   warns when a value resolved from a non-primary name, naming the replacement. One warning per
   variable per process, at startup, not per lookup.
2. **Declare names as lists, always.** Several packages pass bare string literals inline
   (`env.text("SEARCH_MODE")`, `env.boolean(config.allowWrite, "SEARCH_WRITE")`). Hoist every one
   into an exported `*_ENV` constant in the package's `config.ts`, the way `node/teams` and
   `node/tunnel` already do. Then the set of names a package reads is greppable, and the aliases
   live in one place.

A test that walks the exported `*_ENV` constants and asserts every primary name starts with
`DBX_TOOLS_` or appears on the keep-unprefixed list turns this from a convention into a check.
Put it in `packages/test` since it spans packages.

### Also worth fixing while here

- `packages/js/node/appkit-web-search/src/config.ts:84` names its constant `SERVING_ENDPOINT_ENV`
  for the value `DATABRICKS_SERVING_ENDPOINT_NAME`, while `node/appkit-mastra` reads the same
  variable independently. One shared constant.
- Python's `topic_bus.py:335` reads `PYTHON_ENV` / `NODE_ENV` and `engine.py` takes an `environ`
  mapping. Both are generic and stay, but any dbx-owned Python variable added later must use the
  same prefix - add that to the `packages/py/` guidance in `AGENTS.md`.

## Sequencing

1. **Env namespace, alias-only.** Add the `DBX_TOOLS_` primaries as list heads, hoist inline
   literals to constants, add the naming test. No behavior change, nothing to coordinate.
2. **Deprecation warning** once the aliases are in place.
3. **`dbx tunnel`.** New CLI package, recovered proxy, lazy `run` boundary, README, projen wiring
   (`pythonPackages`-style entry in `.projenrc.ts`, then `bunx projen` - never hand-edit a
   `package.json`).
4. **Optional-dependency wins** in `cli-model-proxy` and `@dbx-tools/cli`, only if the lazy
   boundary is real.
5. **Docs pass**: root README tables, `AGENTS.md` Layout + native-overlap bullets, and an env
   table in each affected package README.

## Testing

- Recover the deleted `test/gate.test.ts` proxy-path cases where they still apply, and keep the
  existing `test/gate-middleware.test.ts` green - both paths must gate identically, and a
  divergence between them is the main risk this plan carries.
- Assert the header policy on the CLI path: a caller-supplied `ACCESS_TOKEN_HEADER` must not
  survive, and an unverified `/api/*` request must get `401`.
- Cover flag -> env -> default precedence for every option in the table, since that is the
  regression the user actually asked to prevent.
- Assert each renamed variable resolves from both the new and the old name, and that the new one
  wins when both are set.
