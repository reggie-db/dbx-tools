# `@dbx-tools/auth`

Passwordless authentication runtime built on Better Auth, email OTP, passkeys,
and caller-provided identity policy and delivery.

Key features:

- Better Auth ownership of users, sessions, OTP lifecycle, rate limits, and
  passkey credentials;
- session-required passkey enrollment and discoverable passkey login;
- caller-provided `authorizeIdentity`, email sender, secret, origin, and
  database;
- native AppKit Lakebase pool or local SQLite storage;
- programmatic Better Auth migrations under advisory or file locks.

```ts
import { auth, storage } from "@dbx-tools/auth";

const database = await storage.createAuthStorage({ storage: "sqlite" });
const runtime = await auth.createPasswordlessAuth({
  storage: database,
  baseURL: "http://localhost:8000",
  appName: "My app",
  secret: process.env.AUTH_SECRET!,
  sessionTtlSeconds: 2_592_000,
  codeTtlSeconds: 600,
  maxAttempts: 5,
  authorizeIdentity: (email) => email.endsWith("@example.com"),
  sendCode: async (email, code) => sendEmail(email, code),
});
```

## Modules

- `auth` - Better Auth runtime and compatibility routes;
- `storage` - Lakebase/SQLite selection and migration locking.
