# `@dbx-tools/shared-auth`

Browser-safe schemas and types for passwordless authentication and Databricks
profile selection.

Key features:

- compatibility schemas for email OTP request and verification routes;
- logout result and redirect contract;
- gate status with optional passkey capability;
- Databricks auth-type and target values;
- secret-free profile summaries, profile lists, and selector values;
- resolved Databricks authentication client fields for browser auth checks;
- one shared session-cookie name for Node transports and browser clients.

```ts
import { authStatusSchema } from "@dbx-tools/shared-auth";

const status = authStatusSchema.parse(await response.json());
```

## Modules

- `auth` - passwordless gate wire schemas and types.
- `browser` - Better Auth and passkey browser client.
- `config` - Databricks auth-type and target values.
- `profile` - secret-free profile selector contracts.
- `client` - resolved Databricks authentication client fields.
