# @dbx-tools/cli-tunnel

Front an app with a public tunnel and an email one-time-code access gate.

Built on [portr](https://github.com/amalshaji/portr). Run this CLI when an app
needs to be reachable from outside its network - a stakeholder demo, a webhook
sender that has to reach a dev build, an OAuth redirect that cannot point at
`localhost` - without publishing the app to anyone who learns the URL. It is
shaped for Databricks Apps (it honours the `DATABRICKS_APP_PORT` contract and
lets the platform's own front door through ungated) but the gate itself is
platform-neutral. The CLI wraps the app's real start command: it
moves the app onto a private loopback port, binds the public port with a gate
proxy, and brings the tunnel up alongside it. Access is granted per email
address against an allow-list, verified by a code sent over
[`@dbx-tools/email`](../../node/email).

**Key features:**

- Wraps an unmodified start command - everything after `--` runs as-is, so the
  app needs no tunnel-specific code:
  `dbxt-tunnel --allow example.com -- bun src/server.ts`.
- Branded from the repo-wide brand context: the code email's accent colour, font,
  logo, and display name come from the app's own `branding/brand.yaml` (via
  `@dbx-tools/core`'s `loadBrandContext()`), falling back to the dbx-tools
  default - so the sign-in email looks like the app it fronts with nothing to
  configure. `--brand-name` overrides just the name.
- Conventional one-time-code copy, so platform autofill works: the email is
  `Your verification code is: / <code> / This code expires in N minutes`, and the
  code input carries `autocomplete="one-time-code"`. iOS, Gmail, Outlook, and
  Android detect a code from that shape and offer it directly from the
  notification; novel phrasing is what breaks the detection. Both MIME parts carry
  the code as visible text, never an image.
- Email one-time-code gate: a 6-digit code stored as a SHA-256 hash with an
  attempt counter, verified in constant time, in AppKit's `CacheManager` (memory
  by default, Lakebase when the app configures persistent `CacheStorage`) so TTL
  expiry and eviction are the cache's job.
- Short-lived HS256 session JWT (via `jose`) carrying only the email, signed with
  `AUTH_JWT_SECRET`.
- Allow-list patterns in three shapes, matched in order: a domain shortcut
  (`example.com`, `@example.com`), a shell-style glob (`*@example.com`), or a
  regex literal (`/^ops-.*@example\.com$/`). An empty list allows nobody.
- Per-email and per-IP fixed-window rate limiting, plus anti-enumeration: a code
  request always answers `{ ok: true }`, whether or not the address is allowed.
- Platform traffic passes through UNGATED. The gate distinguishes the portr
  client (a loopback source address, same container) from the hosting platform's
  front door (a non-loopback container-network address), so health checks and the
  workspace UI keep working while public tunnel traffic is gated.
- SPA-aware gating: static assets and the login routes stay open so the browser
  can load the client and render the login form; every other `/api/*` needs a
  valid session cookie or gets `401`. WebSocket upgrades are gated the same way.
- Supervised teardown - the app child, the portr child, and this process are tied
  together, so if any one exits the whole tunnel comes down.
- Fails fast when email is not configured for SMTP, because a gate that cannot
  send codes locks everyone out. `--insecure` is the explicit opt-out.

## Why This Over An Ad-Hoc Tunnel

A bare tunnel (`ngrok`, `portr` on its own) makes the app reachable by anyone
with the URL. This package keeps the tunnel but puts a gate in front of it,
reusing what the app already has: AppKit's cache for code storage, the
`@dbx-tools/email` transport for delivery, and the app's own `From` policy. There
is nothing to add to the app itself - no route, no middleware, no auth library.

## Run It

```sh
dbxt-tunnel \
  --allow "example.com, *@partner.example" \
  --brand-name "Acme Ops" \
  -- bun src/server.ts
```

The package installs two equivalent commands, `dbx-tools-tunnel` and the shorter
`dbxt-tunnel`. Neither matches the package name, so a one-off run has to name the
command explicitly:

```sh
npx --package @dbx-tools/cli-tunnel dbx-tools-tunnel --help
```

Everything after `--` is the real start command. The CLI sets
`DATABRICKS_APP_PORT` to a random private port for that child and binds the
original public port itself.

## Options

Every flag has an environment fallback, so a deployment can configure the gate
with no change to its start command.

| Flag              | Env                | Default                      |
| ----------------- | ------------------ | ---------------------------- |
| `--allow`         | `EMAIL_AUTH_ALLOW` | empty (allow nobody)         |
| `--subject`       | `AUTH_SUBJECT`     | `Your verification code`     |
| `--brand-name`    | `AUTH_BRAND_NAME`  | the brand context `name`     |
| `--message`       | `AUTH_MESSAGE`     | `Your verification code is:` |
| `--session-ttl`   | `AUTH_SESSION_TTL` | `43200` (12 hours)           |
| `--code-ttl`      | `AUTH_CODE_TTL`    | `600` (10 minutes)           |
| `--subdomain`     | -                  | derived from `PUBLIC_DOMAIN` |
| `--public-domain` | `PUBLIC_DOMAIN`    | -                            |
| `--insecure`      | `TUNNEL_INSECURE`  | off (the gate is required)   |

`--allow` and `EMAIL_AUTH_ALLOW` are UNIONED rather than one overriding the
other, so a deployment-wide allow-list and a per-invocation addition both grant
access. Session signing reads `AUTH_JWT_SECRET`; when it is unset the gate mints
an ephemeral per-process key, so sessions simply do not survive a restart rather
than the gate refusing to serve.

## Use The Gate As A Plugin

The gate is an AppKit plugin, so an app that wants the OTP flow without the
tunnel can mount it directly. It registers no routes - it exposes handlers the
caller invokes - and it takes a `sendCode` callback because delivering mail is
the one thing it cannot resolve on its own:

```ts
import { createApp } from "@dbx-tools/appkit";
import { authGate } from "@dbx-tools/cli-tunnel/plugin";
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

`sendCode` is the one thing the plugin cannot resolve on its own. When the tunnel
CLI boots the gate it wires this same callback, and derives the email styling from
the brand context, so mounting the plugin directly is the only case that needs it
by hand.

## Modules

- `cli` - argv parsing, the wrapped-command split at `--`, and process
  supervision.
- `plugin` - `authGate()`, its config/env resolution, and the `AuthGateApi`
  handlers the proxy calls in-process.
- `proxy` - the public-port reverse proxy: loopback-vs-platform classification,
  open login routes, session enforcement, and WebSocket forwarding.
- `otp` - the `CacheManager`-backed code store and the session JWT.
- `allowlist` - domain / glob / regex matching and `looksLikeEmail`.
- `rate-limit` - the in-memory fixed-window limiter (single-instance only; not
  distributed).
- `portr` - portr install, config rendering, and child launch.
- `app` - boots the minimal gate AppKit app and returns the `AuthGateApi`.

Browser-safe login wire schemas (the request/verify payloads and the session
cookie name) live in [`@dbx-tools/shared-email`](../../shared/email); the React
login surface is in [`@dbx-tools/ui-email`](../../ui/email).
