# @dbx-tools/client

Rust-backed Databricks runtime and authentication client.

Key features:

- Databricks App detection and CLI token access.
- U2M browser OAuth, M2M client credentials, and PAT authentication.
- Profile, account, workspace, scope, and endpoint resolution.
- File, memory, or caller-provided credential storage.

```ts
import {
  createPersistentAuth,
  createPersistentAuthForRequest,
  DatabricksAuthOptions,
} from "@dbx-tools/client";

const auth = await createPersistentAuth(DatabricksAuthOptions.create({}));
const token = await auth.token();
```

Automatic local U2M uses the Databricks CLI when available and falls back to
the native browser flow. Inside a Databricks App, automatic storage uses memory
and does not invoke the CLI.

Pass current request headers to `createPersistentAuthForRequest`. Inside an
App, it prefers the `x-forwarded-access-token` OBO token, then the ambient App
service principal:

```ts
const requestHeaders = new Map<string, string>();
const forwardedToken = req.header("x-forwarded-access-token");
if (forwardedToken) requestHeaders.set("x-forwarded-access-token", forwardedToken);
const auth = await createPersistentAuthForRequest(DatabricksAuthOptions.create({}), requestHeaders);
```

Set `authType` to `app_obo` or `app_sp`, or provide `profile`, to force a
specific source.
