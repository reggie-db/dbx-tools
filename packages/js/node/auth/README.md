# `@dbx-tools/auth`

Passwordless authentication runtime built on Better Auth, email OTP, passkeys,
and caller-provided identity policy and delivery.

Key features:

- Better Auth ownership of users, sessions, OTP lifecycle, rate limits, and
  passkey credentials;
- session-required passkey enrollment and discoverable passkey login;
- POST and browser-redirect logout routes with a same-origin destination;
- caller-provided `authorizeIdentity`, email sender, secret, origin, and
  database;
- native AppKit Lakebase pool or local SQLite storage;
- programmatic Better Auth migrations under advisory or file locks.

## Relationship To Native AppKit

Use the Databricks Apps front door and AppKit execution context when traffic
arrives through the platform. Use this package for a public tunnel or another
route that bypasses that identity-aware proxy and therefore needs its own
passwordless session. A passkey session proves the configured identity only; it
does not mint a Databricks OBO access token.

```ts
import { auth, storage } from "@dbx-tools/auth";

const database = await storage.createAuthStorage({ storage: "sqlite" });
const runtime = await auth.createPasswordlessAuth({
  storage: database,
  baseURL: "http://localhost:8000",
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

`POST <basePath>/logout` returns `{ ok, redirectTo }`; `GET` clears the same
session and redirects with status `303`. The redirect defaults to `/` and is
restricted to a same-origin path.

## Modules

- `auth` - Better Auth runtime and compatibility routes;
- `storage` - Lakebase/SQLite selection and migration locking.
