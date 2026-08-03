# @dbx-tools/tunnel

Front an app with a public tunnel and an email one-time-code access gate,
in-process.

Built on [portr](https://github.com/amalshaji/portr). Use this library when an
app needs to be reachable from outside its network - a stakeholder demo, a
webhook sender that has to reach a dev build, an OAuth redirect that cannot point
at `localhost` - without publishing the app to anyone who learns the URL. It is
shaped for Databricks Apps (it honours the `DATABRICKS_APP_PORT` contract and
lets the platform's own front door through ungated) but the gate itself is
platform-neutral.

The tunnel plugs into `@dbx-tools/appkit`'s `createApp` through its INTERCEPTOR
context: `createApp({ interceptor: tunnelInterceptor() })` applies the computed
`DATABRICKS_HOST`, launches portr pointed at the app's public port, and binds it
so the app and portr live and die as one (concurrently-style - signals pass
through, either death tears the pair down). The app is the process; the tunnel
rides along inside it. Access is granted per email address against an allow-list,
verified by a code sent over [`@dbx-tools/email`](../../node/email); the gate
itself is the `authGate` AppKit plugin plus the `startProxy` reverse-proxy, both
exported here for an app that wants to gate the tunnelled traffic.

**Key features:**

- Consumed in-process via the `createApp` interceptor context - no wrapper CLI,
  no separate process: `createApp({ interceptor: tunnelInterceptor() })`. A no-op
  when no `PORTR_TOKEN` / `TUNNEL_PUBLIC_DOMAIN` is set, so it is safe to register
  unconditionally.
- Branded from the repo-wide brand context: the code email's accent colour, font,
  logo, and display name come from the app's own `branding/brand.yaml` (via
  `@dbx-tools/core`'s `loadBrandContext()`), falling back to the dbx-tools
  default - so the sign-in email looks like the app it fronts with nothing to
  configure. `TUNNEL_AUTH_BRAND_NAME` overrides just the name.
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
- The two MIME parts are built separately, on purpose. The HTML part is the full
  branded template with the code as a large styled heading; the `text/plain` part
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
- Email one-time-code gate: a 6-digit code stored as a SHA-256 hash with an
  attempt counter, verified in constant time, in AppKit's `CacheManager` (Lakebase
  when a database is bound to the deployment, else memory) so TTL expiry and
  eviction are the cache's job.
- The gate resolves Lakebase for itself, so its cache is actually persistent. The
  gate is its own tiny AppKit app with no `lakebase()` plugin (it has no server to
  mount routes on), and AppKit only chooses Lakebase for the cache when a pool can
  be built from `LAKEBASE_ENDPOINT` **and** `PGHOST` **and** `PGDATABASE` - while a
  Databricks App `postgres` binding supplies only the first. The gate fills in the
  rest at boot, and skips entirely when nothing is bound rather than creating
  infrastructure on someone else's behalf.
- HS256 session JWT (via `jose`) carrying only the email, signed with a key that
  is PERSISTED in AppKit's cache for 30 days - so a signed-in browser stays signed
  in across the restarts a tunnel sees whenever the app it wraps reloads. An
  operator-held `TUNNEL_AUTH_JWT_SECRET` still wins. `TUNNEL_AUTH_SESSION_CUTOFF`
  is the log-everyone-out switch, and takes a relative duration (`-30d`) as
  readily as a date.
- Allow-list patterns in three shapes, matched in order: a domain shortcut
  (`example.com`, `@example.com`), a shell-style glob (`*@example.com`), or a
  regex literal (`/^ops-.*@example\.com$/`). An empty list allows nobody.
- Per-email and per-IP fixed-window rate limiting, plus anti-enumeration: a code
  request always answers `{ ok: true }`, whether or not the address is allowed.
- Inbound `x-` headers are stripped by default and re-allowed by pattern, so a
  public caller cannot spoof the headers the app trusts - above all
  `x-forwarded-access-token`, which would otherwise let anyone drive the app's
  workspace calls with a pasted token. Add an app's own headers with
  `TUNNEL_FORWARD_HEADERS`.
- Platform traffic passes through UNGATED. The gate distinguishes the portr
  client (a loopback source address, same container) from the hosting platform's
  front door (a non-loopback container-network address), so health checks and the
  workspace UI keep working while public tunnel traffic is gated.
- SPA-aware gating: static assets and the login routes stay open so the browser
  can load the client and render the login form; every other `/api/*` needs a
  valid session cookie or gets `401`. WebSocket upgrades are gated the same way.
- Supervised teardown - `tunnelInterceptor` binds portr through the `createApp`
  interceptor context, so the app and the tunnel are tied together: if either
  exits, `bindProcess` brings the whole set down and passes signals through.
- The gate fails fast when email is not configured for SMTP, because a gate that
  cannot send codes locks everyone out (see `startGateApp` in the `app` module).

## Why This Over An Ad-Hoc Tunnel

A bare tunnel (`ngrok`, `portr` on its own) makes the app reachable by anyone
with the URL. This package keeps the tunnel but puts a gate in front of it,
reusing what the app already has: AppKit's cache for code storage, the
`@dbx-tools/email` transport for delivery, and the app's own `From` policy.
Because it rides inside the app's own `createApp`, there is no second process to
supervise and no wrapper command to thread flags through.

## Run It

```ts
import { createApp } from "@dbx-tools/appkit";
import { server } from "@databricks/appkit";
import { interceptor } from "@dbx-tools/tunnel";

const { tunnelInterceptor } = interceptor;

await createApp.createApp({
  plugins: [server({ host, staticPath })],
  // Applies DATABRICKS_HOST, launches portr at the app's public port, and binds
  // it to the app. No-op when no PORTR_TOKEN / TUNNEL_PUBLIC_DOMAIN is set.
  interceptor: tunnelInterceptor(),
});
```

`tunnelInterceptor(opts)` takes optional `publicDomain` / `subdomain` / `port`;
each falls back to env (and `port` to the `DATABRICKS_APP_PORT` contract), so a
deployment usually passes nothing and configures through the environment. The
OTP gate is a separate concern - see [Use The Gate](#use-the-gate) to mount
`authGate` + `startProxy` for gated traffic.

## Options

The interceptor reads portr wiring from the environment; the gate (the `authGate`
plugin) reads its own settings the same way, so a deployment configures both
without touching code.

| Env                          | Default                      |
| ---------------------------- | ---------------------------- |
| `TUNNEL_AUTH_ALLOW`          | empty (allow nobody)         |
| `TUNNEL_AUTH_SUBJECT`        | `Your verification code`     |
| `TUNNEL_AUTH_BRAND_NAME`     | the brand context `name`     |
| `TUNNEL_AUTH_MESSAGE`        | `Your verification code is:` |
| `TUNNEL_AUTH_SESSION_TTL`    | `2592000` (30 days)          |
| `TUNNEL_AUTH_CODE_TTL`       | `600` (10 minutes)           |
| `TUNNEL_AUTH_SESSION_CUTOFF` | unset (no cutoff)            |
| `TUNNEL_PUBLIC_DOMAIN`       | - (no tunnel when unset)     |
| `TUNNEL_FORWARD_HEADERS`     | the built-in `x-` allow-list |
| `TUNNEL_AUTH_JWT_SECRET`     | an ephemeral per-process key |

Every variable is `TUNNEL_`-prefixed because the tunnel shares one environment
with the app it fronts, so a generic name is one the app may already be using.
The earlier unprefixed spellings - `AUTH_SUBJECT`, `AUTH_BRAND_NAME`,
`AUTH_MESSAGE`, `AUTH_SESSION_TTL`, `AUTH_CODE_TTL`, `AUTH_JWT_SECRET`,
`EMAIL_AUTH_ALLOW`, `PUBLIC_DOMAIN`, plus `TUNNEL_AUTH_SESSION_EPOCH` from before
the cutoff rename - are still read as deprecated aliases, with the `TUNNEL_` name
winning when both are set, so an existing deployment needs no coordinated rename.
`PORTR_TOKEN` / `PORTR_SERVER` keep their names: that namespace belongs to portr
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

The body keeps the code as a large styled heading regardless, for a recipient
reading the mail rather than a notification. This is deliberately NOT Apple's
domain-bound `@domain #code` trailer, which binds a code to a single origin;
subject + preheader works across clients and needs no origin.

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
`startProxy`). Each entry is a literal name, a shell-style glob, or a `/regex/` -
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
anyway. Dropping the transport headers costs nothing: the proxy re-adds them from
the real socket after the policy runs, so the app sees the honest values instead
of the caller's claim. Rate limiting reads the client IP before stripping, and
takes the **rightmost** `x-forwarded-for` entry - the only one a proxy appended
rather than a client supplied.

## Use The Gate

The gate is an AppKit plugin, so an app that wants the OTP flow can mount it
directly - with or without the portr tunnel. It registers no routes - it exposes
handlers the caller invokes (drive them from the `startProxy` reverse-proxy, or
your own server) - and it takes a `sendCode` callback because delivering mail is
the one thing it cannot resolve on its own:

```ts
import { createApp } from "@dbx-tools/appkit";
import { authGate } from "@dbx-tools/tunnel";
import { brand, email, sender, transport } from "@dbx-tools/email";

const handle = await createApp({
  plugins: [
    email({ brand: brand.defaultEmailBrand }),
    authGate({
      allow: ["example.com"],
      sendCode: async (to, code, opts) => {
        const runtime = transport.getEmailRuntime();
        await transport.sendEmail(
          {
            to: [to],
            subject: opts.subject,
            body: `${opts.message}\n\n## ${code}`,
          },
          // The app's configured sender; a code email has no on-behalf-of user.
          sender.resolveSenderAddress(runtime.config, undefined),
        );
      },
    }),
  ],
});

// The gate exposes handlers rather than routes - call them from your own server.
const status = await handle.authGate.status(sessionCookieValue);
```

`sendCode` is the one thing the plugin cannot resolve on its own. The `app`
module's `startGateApp()` wires this same callback and derives the email styling
from the brand context, so mounting the plugin directly is the only case that
needs it by hand.

## Modules

- `interceptor` - `tunnelInterceptor()`, the `createApp` interceptor that applies
  `DATABRICKS_HOST`, launches portr, and binds it to the app.
- `plugin` - `authGate()`, its config/env resolution, and the `AuthGateApi`
  handlers the proxy calls in-process.
- `proxy` - the public-port reverse proxy: loopback-vs-platform classification,
  open login routes, session enforcement, and WebSocket forwarding.
- `otp` - the `CacheManager`-backed code store and the session JWT.
- `signingKey` - the cache-persisted HS256 session key (30-day TTL, get/generate/
  re-read convergence) and the `TUNNEL_AUTH_SESSION_CUTOFF` force-clear cutoff.
- `allowlist` - email domain / glob / regex matching and `looksLikeEmail`.
- `headers` - the inbound-header allow-list: `toHeaderPolicy()`,
  `DEFAULT_FORWARD_HEADERS`, and the `PROTECTED_HEADERS` no pattern can forward.
- `rate-limit` - the in-memory fixed-window limiter (single-instance only; not
  distributed).
- `portr` - portr install, config rendering, and child launch.
- `env` - the environment-variable names, each with its deprecated aliases.
- `app` - boots the minimal gate AppKit app and returns the `AuthGateApi`.

Browser-safe login wire schemas (the request/verify payloads and the session
cookie name) live in [`@dbx-tools/shared-email`](../../shared/email); the React
login surface is in [`@dbx-tools/ui-email`](../../ui/email).
