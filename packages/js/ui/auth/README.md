# `@dbx-tools/ui-auth`

React passwordless authentication surfaces for `@dbx-tools/auth-gate`.

Key features:

- email OTP sign-in with passkey actions presented underneath;
- automatic conditional passkey mediation on supported browsers;
- first-login passkey enrollment prompt;
- authenticated passkey list, rename, add, and remove controls;
- status and logout helpers for tunnel-aware application controls;
- HttpOnly Better Auth sessions with no browser token storage;
- AppKit and dbx-tools branding primitives.

## Relationship To Native AppKit

The native AppKit UI is sufficient when the Databricks Apps front door owns
identity. Use this package with `@dbx-tools/auth-gate` when a public tunnel bypasses
that front door and needs passkey-first login plus email OTP recovery.

```tsx
import { AuthGate } from "@dbx-tools/ui-auth/react";

root.render(
  <AuthGate>
    <App />
  </AuthGate>,
);
```

`getAuthStatus()` reports whether the current request is behind the tunnel gate.
`logout()` clears the session and navigates to the server-configured login
destination.

## Public subpaths

- `@dbx-tools/ui-auth/react` - `AuthGate`, `PasskeyManager`, `getAuthStatus`,
  and `logout`.
