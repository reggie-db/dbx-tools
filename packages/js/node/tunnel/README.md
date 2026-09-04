# @dbx-tools/tunnel

Front an app with a public Portr and/or FRP tunnel and the passwordless
[`@dbx-tools/auth-gate`](../auth-gate) gate, in-process.

Supports the [SSE-enabled Portr fork](https://github.com/reggie-db/portr/releases/tag/v1.0.15-sse.2),
based on [upstream Portr](https://github.com/amalshaji/portr), plus
[FRP](https://github.com/fatedier/frp). Use this library
when an app needs to be reachable from outside its network - a stakeholder demo,
a webhook sender that has to reach a dev build, an OAuth redirect that cannot
point at `localhost` - without publishing the app to anyone who learns the URL.
It is shaped for Databricks Apps (it honours the `DATABRICKS_APP_PORT` contract
and lets the platform's own front door through ungated) but the gate itself is
platform-neutral.

The tunnel plugs into `@dbx-tools/appkit`'s `createApp` through its INTERCEPTOR
context: `createApp({ interceptor: tunnelInterceptor() })` applies the computed
`DATABRICKS_HOST`, launches the selected client(s) pointed at the app's public
port, and binds them so the app and tunnels live and die as one (signals pass
through, either death tears the pair down). The app is the process; the tunnel
rides along inside it. Access is granted per email address against an allow-list,
authenticated by Better Auth email OTP or a passkey; the gate itself is the
`authGate` AppKit plugin, which registers the login routes and a gating
middleware on the app's OWN Express server (no separate proxy process).

**Key features:**

- Consumed in-process via the `createApp` interceptor context - no wrapper CLI,
  no separate process: `createApp({ interceptor: tunnelInterceptor() })`. A no-op
  when the selected clients are not configured, so it is safe to register
  unconditionally.
- Uses the shared email-template brand for the code email's color, font, and
  logo. The displayed app name defaults to the dbx-tools brand and can be set
  with `brandName` or `TUNNEL_AUTH_BRAND_NAME`.
- Conventional one-time-code copy, so platform autofill works: the email is
  `Your verification code is: / <code> / This code expires in N minutes`, and the
  code input carries `autocomplete="one-time-code"`. iOS, Gmail, Outlook, and
  Android detect a code from that shape and offer it directly from the
  notification; novel phrasing is what breaks the detection. Both MIME parts carry
  the code as visible text, never an image, and no trailer follows the copy.
- The code rides in the SUBJECT and the preheader, not only the body:
  `123456 is your verification code`. Mobile autofill reads an incoming
  NOTIFICATION, and a notification contains the sender, the subject, and a short
  snippet - nothing else - so a code that lives only in the body is unreachable
  however cleanly the body is shaped. See
  [Why the code is in the subject](#why-the-code-is-in-the-subject).
- The two MIME parts are built separately, on purpose. The HTML card uses the
  configured subject template as its neutral title and shows the code once as a
  large styled body heading; the `text/plain` part
  is authored directly, keeping the prompt and the code on ONE line
  (`Your verification code is: 123456`) because that is the shape client code
  detection reads most reliably. A generated text part cannot hold it - the text
  part is a rendering of the HTML, so the heading's CSS margin arrives as blank
  lines and autofill stops being offered while the HTML still looks perfect. See
  `codeEmailTextBody` in the `app` module.
- The sign-in code is SYSTEM mail: it sends from `no-reply@EMAIL_DOMAIN` (or
  `EMAIL_SYSTEM_FROM`), never a person's address, since a reply to a
  machine-generated code reaches nobody. `EMAIL_FROM` is not required - see
  [`@dbx-tools/email`](../../node/email#sender-addresses).
- Better Auth owns users, hashed OTP verification records, sessions, rate
  limits, and passkey credentials. `@dbx-tools/tunnel` supplies only its
  authorization policy, branded email delivery, and transport boundary.
- Storage is the native AppKit `lakebase()` pool when registered, or SQLite in
  the operating system's application-data directory. Both adapters run Better
  Auth's own migrations under a Postgres advisory lock or file lock.
- Email OTP remains bootstrap and recovery. Returning users can authenticate
  with discoverable passkeys, enroll multiple devices, and name or remove them
  through [`@dbx-tools/ui-auth`](../../ui/auth).
- Allow-list patterns in three shapes, matched in order: a domain shortcut
  (`example.com`, `@example.com`), a shell-style glob (`*@example.com`), or a
  regex literal (`/^ops-.*@example\.com$/`). An empty list allows nobody.
- Better Auth rate limiting plus anti-enumeration: the compatibility code
  request always answers `{ ok: true }`, whether or not the address is allowed.
- Inbound `x-` headers are stripped by default and re-allowed by pattern, so a
  public caller cannot spoof the headers the app trusts - above all
  `x-forwarded-access-token`, which would otherwise let anyone drive the app's
  workspace calls with a pasted token. Add an app's own headers with
  `TUNNEL_FORWARD_HEADERS`.
- Only PORTR traffic is gated. The gate identifies tunnel requests by their
  `Host` header (`TUNNEL_PUBLIC_DOMAIN`), which portr's client preserves from the
  public visitor. Platform front-door traffic and any other local caller carry a
  different `Host` and pass through UNGATED, so health checks and the workspace UI
  keep working. (There is no portr-injected identifying header and no source-IP
  signal - the client dials the app over plain loopback - so `Host` is the signal.)
- SPA-aware gating: static assets and the login routes stay open so the browser
  can load the client and render the login form; every other `/api/*` needs a
  valid session cookie or gets `401`. A WebSocket handshake is an ordinary `GET`
  and runs through the same gate.
- Supervised teardown - `tunnelInterceptor` binds portr through the `createApp`
  interceptor context, so the app and the tunnel are tied together: if either
  exits, `bindProcess` brings the whole set down and passes signals through.
- The gate fails fast when email is not configured for SMTP, because a gate that
  cannot send codes locks everyone out. `@dbx-tools/email` is an OPTIONAL peer
  dependency, imported lazily; the app that mounts the gate provides it.

## Why This Over An Ad-Hoc Tunnel

A bare tunnel (`ngrok`, `portr` on its own) makes the app reachable by anyone
with the URL. This package keeps the tunnel but puts a gate in front of it,
reusing what the app already has: AppKit's cache for code storage, the
`@dbx-tools/email` transport for delivery, and the app's own `From` policy.
Because it rides inside the app's own `createApp`, there is no second process to
supervise and no wrapper command to thread flags through.

## Run It

```ts
import { appkit } from "@dbx-tools/appkit";
import { email } from "@dbx-tools/email";
import { server } from "@databricks/appkit";
import { interceptor, plugin } from "@dbx-tools/tunnel";

const { tunnelInterceptor } = interceptor;
const { authGate } = plugin;

await appkit.createApp({
  plugins: [
    server({ host, staticPath }),
    // Delivers the OTP codes; the gate reuses this shared transport.
    email(),
    // The OTP gate: login routes + a gating middleware on THIS server. Gates only
    // public tunnel traffic; the platform front door passes
    // through. Inert when no tunnel domain is configured.
    authGate({}),
  ],
  // Applies DATABRICKS_HOST and launches FRP. Use "both" to launch Portr too.
  interceptor: tunnelInterceptor({ transport: "frp" }),
});
```

Two pieces, one process: `tunnelInterceptor()` runs the selected tunnel clients
(children bound to the app), and `authGate()` is the in-app gate. Portr remains
the default. Set `transport: "frp"` or `DBX_TOOLS_TUNNEL_TRANSPORT=frp`; use `both` with
separate `TUNNEL_PUBLIC_DOMAIN` and `TUNNEL_FRP_PUBLIC_DOMAIN` hosts.
See [Use The Gate](#use-the-gate) for the gate on its own.

## Options

The interceptor reads tunnel wiring from the environment; the gate (the `authGate`
plugin) reads its own settings the same way, so a deployment configures both
without touching code.

| Env                           | Default                      |
| ----------------------------- | ---------------------------- |
| `TUNNEL_AUTH_ALLOW`           | empty (allow nobody)         |
| `TUNNEL_AUTH_SUBJECT`         | `Your verification code`     |
| `TUNNEL_AUTH_BRAND_NAME`      | the brand context `name`     |
| `TUNNEL_AUTH_MESSAGE`         | `Your verification code is:` |
| `TUNNEL_AUTH_SESSION_TTL`     | `2592000` (30 days)          |
| `TUNNEL_AUTH_CODE_TTL`        | `600` (10 minutes)           |
| `TUNNEL_AUTH_SESSION_CUTOFF`  | unset (no cutoff)            |
| `TUNNEL_AUTH_LOGOUT_REDIRECT` | `/` (show login again)       |
| `TUNNEL_PUBLIC_DOMAIN`        | - (no tunnel when unset)     |
| `TUNNEL_FRP_PUBLIC_DOMAIN`    | - (no FRP tunnel when unset) |
| `DBX_TOOLS_TUNNEL_TRANSPORT`  | `portr`                      |
| `FRP_SERVER`                  | FRP public domain            |
| `FRP_SERVER_PORT`             | `443`                        |
| `FRP_PROTOCOL`                | `wss`                        |
| `FRP_TOKEN`                   | unset (no frps auth)         |
| `FRP_PROXY_NAME`              | public domain's first label  |
| `FRP_PATH`                    | `DATABRICKS_APP_NAME`        |
| `FRP_STRIP_PREFIX`            | `true` for non-root paths    |
| `TUNNEL_FORWARD_HEADERS`      | the built-in `x-` allow-list |
| `TUNNEL_AUTH_JWT_SECRET`      | an ephemeral per-process key |

Every variable is `TUNNEL_`-prefixed because the tunnel shares one environment
with the app it fronts, so a generic name is one the app may already be using.
The earlier unprefixed spellings - `AUTH_SUBJECT`, `AUTH_BRAND_NAME`,
`AUTH_MESSAGE`, `AUTH_SESSION_TTL`, `AUTH_CODE_TTL`, `AUTH_JWT_SECRET`,
`EMAIL_AUTH_ALLOW`, `PUBLIC_DOMAIN`, plus `TUNNEL_AUTH_SESSION_EPOCH` from before
the cutoff rename - are still read as deprecated aliases, with the `TUNNEL_` name
winning when both are set, so an existing deployment needs no coordinated rename.
`PORTR_*` and `FRP_*` keep their names: those namespaces belong to the clients
itself, as does `DATABRICKS_APP_PORT`, which the platform sets and the tunnel
honours.

## Sessions That Survive A Restart

The signing key decides whether an already-issued session COOKIE still verifies,
so where that key comes from is what decides whether a restart signs everyone out.
Resolution order:

1. **`TUNNEL_AUTH_JWT_SECRET`**, when set. The right answer for a fleet: an
   operator-held secret needs no shared cache, and it survives a cache flush.
2. **A key persisted in AppKit's cache for 30 days.** With a persistent
   `CacheStorage` (Lakebase) the key outlives the process, so cookies stay valid
   across restarts - which a tunnel does often, since it restarts whenever the app
   it wraps reloads. On the default in-memory cache the key is per-process, the
   same as having no secret at all.

   Getting that persistence is not automatic, and the gate does the work at boot
   via `lakebaseResolver.applyLakebaseEnv()`: it turns `LAKEBASE_ENDPOINT` into the
   `PGHOST` / `PGDATABASE` / `PGUSER` the cache's pool also needs. Without them
   AppKit cannot build the pool, silently uses an in-memory cache, and every
   redeploy signs everyone out - so the startup log says which one you got
   (`lakebase resolved for the gate cache`, or `the gate cache stays in memory`).
   Bind a `postgres` resource to the app to get the persistent path.

3. **An ephemeral per-process key**, when there is no secret and no reachable
   cache. Sessions do not survive a restart, but the gate still serves: the key
   only validates an ALREADY-issued session, so losing it costs sessions, never
   admission. A caller still needs a code delivered to an allow-listed address.

The cached key is read, generated-and-stored, then **re-read**. Two instances
booting together both miss the cache, so both generate; adopting whatever is
STORED afterwards is what makes them converge on one key instead of each trusting
the one it minted. Set `TUNNEL_AUTH_JWT_SECRET` to remove the race entirely.

`TUNNEL_AUTH_SESSION_TTL` defaults to the same 30 days the key is stored for, on
purpose - a key that expired before the cookies it signed would sign everyone out
for no reason.

## Why The Code Is In The Subject

The subject line the gate SENDS is `123456 is your verification code` -
`--subject` is the template the code is spliced into, not the literal line.

Mobile autofill does not read the email; it reads the NOTIFICATION. iOS scans
incoming notification text for a code and offers to fill it - natively for
Messages and Mail, and since iOS 26 for any app's notification, which is what
finally made Gmail work. A notification carries the sender, the subject, and a
short snippet. That is all. A code sitting in the body is invisible to it no
matter how carefully the body is formatted, which is why a perfectly shaped
`text/plain` part alone produced no prompt in Gmail.

So the code goes in both strings a notification actually shows:

- **The subject**, code FIRST, because a notification and an inbox row both
  truncate: `123456 is your verification code` survives the cut wherever it lands,
  and keeps the code in the same sentence as the words the heuristics look for.
  A subject that does not use the conventional `Your ...` phrasing is treated as
  deliberate and only prefixed (`123456 - Acme Ops access`).
- **The preheader**, the hidden snippet a client shows beside the subject and puts
  in the notification body, repeating the prompt with the code
  (`Your verification code is: 123456`).

The opened card keeps the configured subject template as a code-free title and
shows the code once as a large styled body heading. This is deliberately NOT
Apple's domain-bound `@domain #code` trailer, which binds a code to a single
origin; subject + preheader works across clients and needs no origin.

### Signing everyone out

`TUNNEL_AUTH_SESSION_CUTOFF` (or `sessionCutoff` on the `authGate` config)
invalidates every session issued before a given moment:

```sh
TUNNEL_AUTH_SESSION_CUTOFF="-30d" ...       # a relative duration
TUNNEL_AUTH_SESSION_CUTOFF="2026-08-02" ... # a date
TUNNEL_AUTH_SESSION_CUTOFF="now" ...         # sign everyone out on this boot
```

The value goes through `@dbx-tools/shared-core`'s `object.toDate`, so a date, an
ISO instant, epoch seconds or millis from `date +%s`, and a relative duration
(`-30d`, `12 hours ago`) all work - the relative spelling being the one an
operator usually wants, since "sign out anything older than a month" needs no
timestamp arithmetic. It works two ways at once, so it holds however the key was
resolved: the cutoff is part of the key's CACHE KEY (moving it orphans the
previous key), and it is also checked against each token's `iat` (which is what
makes it bite when `TUNNEL_AUTH_JWT_SECRET` is set and there is no key to
rotate).

A FUTURE date is clamped to now, because an unclamped one would refuse the
sessions it is about to mint as well as the old ones - an app nobody can sign in
to, from a mistyped year. An unparseable value is ignored with a warning rather
than failing startup: this is the switch that gets a fleet back in.

## Inbound Header Policy

Tunnel traffic arrives from the public internet, so every header on it is
attacker-controlled - and the headers an app trusts are exactly the ones a caller
must not be able to write, because the app cannot tell a header the Databricks
front door set from one a browser typed.

Enumerating headers to remove is a losing game (a deny-list is only correct until
the platform adds a header), so the policy is inverted: **every `x-`-prefixed
request header is stripped from tunnel traffic unless a pattern allows it.** A
header nobody thought about is removed rather than trusted. Non-`x-` headers -
`content-type`, `accept`, `authorization`, `cookie` - are the app's normal input
and pass through untouched.

The default allow-list covers the `x-` namespaces this repo's own client sends
and its own server reads, so a dbx-tools app works behind the tunnel with no
configuration:

| Pattern            | Why                                                 |
| ------------------ | --------------------------------------------------- |
| `x-mastra-*`       | thread and model routing for `@dbx-tools/ui-mastra` |
| `x-mlflow-*`       | MLflow trace correlation for feedback               |
| `x-requested-with` | the conventional AJAX marker                        |

Add an app's own headers with `TUNNEL_FORWARD_HEADERS` (or `forwardHeaders` on
`authGate`). Each entry is a literal name, a shell-style glob, or a `/regex/` -
the same three shapes the email allow-list takes - and the configured list is
UNIONED with the defaults, so extending it never silently breaks the built-in
surfaces:

```sh
TUNNEL_FORWARD_HEADERS="x-acme-*, /^x-trace-/, x-tenant" ...
```

Some headers no pattern can forward. These decide who a request is and where it
came from, and on tunnel traffic only the gate may answer that:

| Header                                | Why it is never forwarded                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-forwarded-access-token`            | OBO auth. A pasted workspace token would make every call in the app run as its owner; a verified email proves nothing about who a credential belongs to. |
| `x-forwarded-user`, `-email`          | Caller identity. The gate sets these itself, from a verified session.                                                                                    |
| `x-forwarded-preferred-username`      | Display identity from the IdP.                                                                                                                           |
| `x-forwarded-host`, `-proto`, `-port` | Original host/scheme/port. Spoofing them poisons absolute URLs the app builds, or makes a plaintext request look like TLS.                               |
| `x-forwarded-for`, `x-real-ip`        | Client IP. Spoofing forges the audit trail and gives a caller a fresh rate-limit bucket per request.                                                     |
| `x-request-id`                        | Request correlation UUID. Forged or colliding ids make logs unreliable.                                                                                  |

The identity headers are AppKit's OBO contract; the rest are the
[`X-Forwarded-*` set Databricks Apps documents passing to an
app](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/http-headers),
plus the conventional `x-forwarded-proto`/`-port`/`x-real-ip` a library may read
anyway. Dropping the transport headers costs nothing: `xfwd` re-adds them from the
real socket after the policy runs, so the app sees the honest values instead of the
caller's claim. Rate limiting reads the client IP before stripping, and takes the
**rightmost** `x-forwarded-for` entry - the only one portr appended rather than a
client supplied.

## Use The Gate

`authGate()` is the gate. Register it in your app's `createApp` plugins and it
mounts the `/api/email/auth/*` login routes plus a gating middleware on your app's
own server (via AppKit's `this.context`). By default it delivers codes through the
app's shared `@dbx-tools/email` transport - so the minimal wiring is just an
`allow` list (or `TUNNEL_AUTH_ALLOW`):

```ts
import { appkit } from "@dbx-tools/appkit";
import { email } from "@dbx-tools/email";
import { authGate } from "@dbx-tools/tunnel";

await appkit.createApp({
  plugins: [
    server({ host, staticPath }),
    email(), // the gate reuses this transport to send codes
    authGate({ allow: ["example.com"] }),
  ],
});
```

Override `sendCode` only to deliver through something other than the shared
transport; the default builds the OTP email (code in the subject + preheader for
mobile autofill) and sends it as the system sender. `@dbx-tools/email` is an
OPTIONAL peer dependency - a tunnel without the gate needs no mail - so the app
that mounts `authGate` must include it (or run `TUNNEL_INSECURE=true` to skip the
gate); a missing transport fails fast at boot.

`GET /api/email/auth/status` is what a client asks before deciding to render a
login screen, and it answers per REQUEST, not per deployment: on a non-tunnel
`Host` it returns `{ authenticated: false, enabled: false }` without looking at
the cookie, because that request was never going to be gated. So the same running
app shows the OTP screen to a portr visitor and no login at all to a browser on
`localhost` or the platform front door.

When the hosted login page interrupts a navigation, it carries the original
same-origin path through the login flow and replaces the page with that path
after OTP verification. API denials expose the hosted login URL in `loginPath`;
its `returnTo` query value comes from a same-origin referrer and is normalized
to an application path, so it cannot become an external redirect.

`POST /api/email/auth/logout` clears the current session and returns
`{ ok, redirectTo }`. `GET` on the same path clears the session and answers with
a `303` redirect. `logoutRedirectPath` or
`TUNNEL_AUTH_LOGOUT_REDIRECT` controls the same-origin destination; `/` is the
default because reloading the application root presents the login gate again.

## Verify The Live Portr Install

The normal test task skips the networked portr release download. Run the
integration test explicitly when validating GitHub release discovery, archive
selection, executable installation, and the downloaded CLI:

```sh
RUN_LIVE_INSTALL_TEST=1 bun test packages/js/node/tunnel/test/portr-install.integration.test.ts
```

The test installs into an isolated temporary home, runs `portr --version`, logs
the selected release and executable path, then removes the temporary directory.
The same command also discovers `frp-install.integration.test.ts`; it downloads
the pinned `frpc` release and verifies its exact version. On macOS the installer
applies an ad-hoc signature before version detection because the unsigned
upstream binary is otherwise terminated by the platform loader.

## Modules

- `interceptor` - `tunnelInterceptor()`, the `createApp` interceptor that applies
  `DATABRICKS_HOST`, launches Portr/FRP, and binds clients to the app.
- `frp` - frpc config resolution, pinned install, TOML rendering, and child launch.
- `plugin` - `authGate()`, authorization/delivery config, Better Auth
  composition, and AppKit Lakebase discovery.
- `gate` - the login routes + gating middleware (`mountGate`, `isTunnelHost`):
  `Host`-based tunnel classification, session enforcement, and identity injection.
- `send-code` - the default OTP delivery through the shared email transport
  (lazily imported) and the SMTP fail-fast.
- `code-email` - pure builders for the code email's subject/preheader/bodies.
- `signingKey` - the cache-persisted Better Auth secret and
  `TUNNEL_AUTH_SESSION_CUTOFF` force-clear cutoff.
- `allowlist` - email domain / glob / regex matching and `looksLikeEmail`.
- `headers` - the inbound-header allow-list: `toHeaderPolicy()`,
  `DEFAULT_FORWARD_HEADERS`, and the `PROTECTED_HEADERS` no pattern can forward.
- `rate-limit` - the in-memory fixed-window limiter (single-instance only; not
  distributed).
- `portr` - portr install, config rendering, and child launch.
- `env` - the environment-variable names, each with its deprecated aliases.

Browser-safe gate contracts live in
[`@dbx-tools/shared-auth`](../../shared/auth); the passkey-first React login and
credential manager live in [`@dbx-tools/ui-auth`](../../ui/auth).
