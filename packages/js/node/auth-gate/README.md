# @dbx-tools/auth-gate

Create a platform-neutral passwordless runtime with Better Auth, email
one-time passwords, passkeys, caller-provided identity policy, and persistent
storage.

For a Databricks App behind a public tunnel, use the higher-level
`authGate()` plugin from `@dbx-tools/tunnel`:

```ts
import { server } from "@databricks/appkit";
import { appkit } from "@dbx-tools/appkit";
import { email } from "@dbx-tools/email";
import { authGate, tunnelInterceptor } from "@dbx-tools/tunnel";

await appkit.createApp({
  plugins: [server(), email(), authGate({ allow: ["example.com"] })],
  interceptor: tunnelInterceptor(),
});
```

This composition gates only requests for the configured public tunnel host.
The Databricks Apps front door and local development host continue to use
AppKit identity.

## Create a direct passwordless runtime

Use this package directly when you own the HTTP routing, identity policy, and
code delivery:

```ts
import { auth, authStorage, type AuthEmailOptions } from "@dbx-tools/auth-gate";

async function deliverCode(email: string, code: string, options: AuthEmailOptions): Promise<void> {
  const endpoint = process.env.CODE_DELIVERY_URL;
  if (!endpoint) {
    throw new Error("CODE_DELIVERY_URL is required");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code, ...options }),
  });
  if (!response.ok) {
    throw new Error(`Code delivery failed with status ${response.status}`);
  }
}

const database = await authStorage.createAuthStorage({ storage: "sqlite" });
const secret = process.env.AUTH_SECRET;
if (!secret) {
  throw new Error("AUTH_SECRET is required");
}

const runtime = await auth.createPasswordlessAuth({
  storage: database,
  baseURL: "http://localhost:8000",
  trustedOrigins: ["https://overlay.example.com"],
  appName: "My app",
  secret,
  logoutRedirectPath: "/",
  sessionTtlSeconds: 2_592_000,
  codeTtlSeconds: 600,
  maxAttempts: 5,
  authorizeIdentity: (email) => email.endsWith("@example.com"),
  sendCode: (email, code, options) => deliverCode(email, code, options),
});
```

Mount `runtime.handler(request)` under `runtime.basePath`, which defaults to
`/api/auth`. Use `runtime.session(headers)` when the application needs the
verified email address. Call `runtime.close()` during server shutdown so the
storage adapter can release its resources.

## Choose direct or tunnel integration

Use AppKit execution context for traffic that enters through the Databricks
Apps front door. That front door supplies platform identity and can supply an
on-behalf-of token.

Use `@dbx-tools/tunnel` when an AppKit application also has a public Portr or
FRP entrance. Its `authGate()` plugin:

- Classifies tunnel traffic by the configured `Host` header.
- Mounts login and compatibility routes on AppKit's server.
- Leaves platform front-door and local traffic ungated.
- Sends codes through the registered `@dbx-tools/email` plugin.
- Removes untrusted forwarded identity and token headers.
- Injects the verified tunnel email as request identity.

Use `@dbx-tools/auth-gate` directly for another HTTP stack or a route that
doesn't need tunnel classification. The direct runtime doesn't mount AppKit
middleware, forward identity headers, or launch a tunnel.

A passkey or email-code session proves only the configured identity. It
doesn't mint a Databricks on-behalf-of token.

## Configure storage

Better Auth stores users, sessions, OTPs, rate limits, and passkeys. Storage can
use an AppKit Lakebase pool or local SQLite:

```ts
import { authStorage } from "@dbx-tools/auth-gate";

const sqlite = await authStorage.createAuthStorage({
  storage: "sqlite",
  sqlitePath: "./data/auth.sqlite",
});
```

`storage: "auto"` uses a supplied Lakebase pool unless you request SQLite. If
SQLite isn't available in automatic mode, the runtime uses an in-memory
adapter. An explicit `storage: "sqlite"` setting fails instead of selecting
memory. In-memory users, OTPs, sessions, and passkeys disappear when the
process exits.

Better Auth migrations run under a PostgreSQL advisory lock for Lakebase or a
file lock for SQLite.

## Use the compatibility routes

`POST <basePath>/logout` returns `{ ok, redirectTo }`. `GET` clears the same
session and redirects with status `303`. The redirect defaults to `/` and is
restricted to a same-origin path. Better Auth accepts only `baseURL` and
`trustedOrigins`. An arbitrary request Origin or Referer is rejected. Inside a
Databricks App, HTTPS `*.databricksapps.com` origins are accepted automatically
for the platform front door. WebAuthn still uses the configured `baseURL` host
for its RP ID and expected origin.

`GET <basePath>/status` returns the verified session status. OTP send and
verification use Better Auth's native email OTP routes under the same base
path.

## Understand authentication limits

- `authorizeIdentity` runs for normalized lowercase email addresses. An
  unauthorized code request doesn't reveal whether the address is allowed.
- The runtime stores OTP values as hashes and limits code attempts and request
  rates through Better Auth.
- `baseURL` determines secure-cookie behavior, the WebAuthn relying-party ID,
  and the expected passkey origin. Configure the external browser origin, not a
  private loopback address, in production.
- `trustedOrigins` extends the accepted browser origins. Arbitrary `Origin` and
  `Referer` values are rejected.
- The runtime is an authentication boundary, not a Databricks authorization
  client. Downstream Databricks calls still need AppKit or another credential
  source.
