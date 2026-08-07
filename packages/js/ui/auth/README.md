# `@dbx-tools/ui-auth`

React passwordless authentication surfaces for `@dbx-tools/auth`.

Key features:

- passkey-first sign-in with email OTP recovery;
- first-login passkey enrollment prompt;
- authenticated passkey list, rename, add, and remove controls;
- HttpOnly Better Auth sessions with no browser token storage;
- AppKit and dbx-tools branding primitives.

## Relationship To Native AppKit

The native AppKit UI is sufficient when the Databricks Apps front door owns
identity. Use this package with `@dbx-tools/auth` when a public tunnel bypasses
that front door and needs passkey-first login plus email OTP recovery.

```tsx
import { AuthGate } from "@dbx-tools/ui-auth/react";

root.render(
  <AuthGate>
    <App />
  </AuthGate>,
);
```

## Public subpaths

- `@dbx-tools/ui-auth/react` - `AuthGate` and `PasskeyManager`.
