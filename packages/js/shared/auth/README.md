# `@dbx-tools/shared-auth`

Browser-safe schemas and types for the dbx-tools passwordless authentication
gate.

Key features:

- compatibility schemas for email OTP request and verification routes;
- logout result and redirect contract;
- gate status with optional passkey capability;
- one shared session-cookie name for Node transports and browser clients.

```ts
import { authStatusSchema } from "@dbx-tools/shared-auth";

const status = authStatusSchema.parse(await response.json());
```

## Modules

- `auth` - passwordless gate wire schemas and types.
