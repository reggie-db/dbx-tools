# `@dbx-tools/auth-gate`

Passwordless authentication runtime built on Better Auth, email OTP, passkeys,
and caller-provided identity policy and delivery.

## Quick Start

```ts
import { auth, authStorage } from "@dbx-tools/auth-gate";

const database = await authStorage.createAuthStorage({ storage: "sqlite" });
const runtime = await auth.createPasswordlessAuth({
  storage: database,
  baseURL: "http://localhost:8000",
  trustedOrigins: ["https://overlay.example.com"],
  appName: "My app",
  secret: process.env.AUTH_SECRET!,
  logoutRedirectPath: "/",
  sessionTtlSeconds: 2_592_000,
  codeTtlSeconds: 600,
  maxAttempts: 5,
  authorizeIdentity: (email) => email.endsWith("@example.com"),
  sendCode: async (email, code) => sendEmail(email, code),
});
```

## Use With Native AppKit

Use the Databricks Apps front door and AppKit execution context for platform
traffic. Use this package for a public tunnel or another route that bypasses
that identity-aware proxy and needs its own passwordless session. A passkey
session proves the configured identity; it does not mint a Databricks OBO token.

Better Auth stores users, sessions, OTPs, rate limits, and passkeys. Storage can
use the AppKit Lakebase pool or local SQLite, and migrations run under advisory
or file locks.

`POST <basePath>/logout` returns `{ ok, redirectTo }`; `GET` clears the same
session and redirects with status `303`. The redirect defaults to `/` and is
restricted to a same-origin path. Better Auth accepts only `baseURL` and
`trustedOrigins`; an arbitrary request Origin or Referer is rejected. Inside a
Databricks App, HTTPS `*.databricksapps.com` origins are accepted automatically
for the platform front door. WebAuthn still uses the configured `baseURL` host
for its RP ID and expected origin.

## Modules

- `auth` - Better Auth runtime and compatibility routes;
- `storage` - Lakebase/SQLite selection and migration locking.
