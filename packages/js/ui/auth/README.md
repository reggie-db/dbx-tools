# `@dbx-tools/ui-auth`

React passwordless authentication surfaces for `@dbx-tools/auth`.

Key features:

- passkey-first sign-in with email OTP recovery;
- first-login passkey enrollment prompt;
- authenticated passkey list, rename, add, and remove controls;
- HttpOnly Better Auth sessions with no browser token storage;
- AppKit and dbx-tools branding primitives.

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
