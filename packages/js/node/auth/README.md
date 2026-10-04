# `@dbx-tools/auth`

Persistent Databricks authentication for Node.js and Bun without a native
binding requirement.

Outside Databricks Apps, the package delegates U2M and PAT authentication to the
Databricks CLI. It reuses a compatible installed CLI or checksum-verifies and
installs the pinned build asset through `@dbx-tools/core/bin`. Inside Databricks
Apps, it accepts request-scoped App OBO headers or App SP environment
credentials. No browser OAuth flow is implemented.

## Features

- Version-checked CLI-only U2M and PAT outside Databricks Apps.
- App SP and request-scoped App OBO authentication inside Databricks Apps.
- Databricks profile parsing with `__settings__.default_profile`, `DEFAULT`, and
  sole-profile selection.
- Optional preference for one matching CLI U2M profile over an implicit M2M
  default. Explicit profiles are never remapped.
- Check-lock-recheck token acquisition and rejected-token refresh.
- File or memory credential storage with caller-defined storage and lock
  adapters.
- Same-origin authorization headers and one rejected-token retry in the bundled
  fetch client.
- Secret-free profile enumeration with explicit cache refresh.

The Databricks CLI does not expose generated M2M bearer tokens. A non-App M2M
profile therefore fails explicitly instead of silently switching to a custom
OAuth implementation. Use a CLI U2M or PAT profile outside Apps.

## Basic use

```ts
import { createPersistentAuth, DatabricksAuthOptions } from "@dbx-tools/auth";

const auth = await createPersistentAuth(DatabricksAuthOptions.create({ profile: "DEFAULT" }));
const headers = await auth.headers();
```

`headers()` returns the complete request header record, including
`authorization` and `x-databricks-workspace-id` when the selected profile has a
`workspace_id`. It allows login when a credential is missing or cannot refresh.
Pass `false` to keep the call non-interactive:

```ts
const headers = await auth.headers(false);
```

`token()` remains available when only the token record is needed. Use
`requestHeadersForUrl()` when applying credentials to an arbitrary URL; it
returns headers only when the request URL has the same origin as the resolved
Databricks host.

## Portable storage

`CredentialStore` and `LockAdapter` use data records, strings, numbers, and
promises. A Python or FFI bridge can implement them without passing JavaScript
callbacks across the boundary. Locks return an opaque lease ID that is released
explicitly.

```ts
import {
  createPersistentAuthWithStorage,
  DatabricksAuthOptions,
  type CredentialStore,
} from "@dbx-tools/auth";

const store: CredentialStore = implementation;
const auth = await createPersistentAuthWithStorage(
  DatabricksAuthOptions.create({ profile: "DEFAULT" }),
  store,
);
```

The built-in file store uses `@dbx-tools/core/file-lock` and preserves unrelated
entries in `~/.databricks/token-cache.json`.

## Modules

- `databricksAuth` provides `PersistentAuth` and Databricks provider construction.
- `profile` parses and resolves Databricks configuration.
- `lifecycle` implements provider-neutral token coordination.
- `storage` and `nodeStorage` provide memory and file adapters.
- `appServicePrincipal` provides the App-only client-credentials provider.
- `httpClient` provides a small fetch-based Databricks JSON client.
