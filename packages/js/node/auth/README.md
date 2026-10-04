# `@dbx-tools/auth`

Persistent Databricks authentication for Node.js and Bun without a native
binding requirement.

The package prefers the Databricks CLI for automatic user authentication. When
the CLI is unavailable, it uses a browser authorization-code flow implemented
with `oauth4webapi` and opens the authorization URL with `open`. M2M uses OAuth
client credentials. PAT, Databricks App service-principal, and App OBO
credentials use the same profile and request policy.

## Features

- CLI-first U2M with native browser fallback.
- M2M, PAT, App SP, and request-scoped App OBO authentication.
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

## Basic use

```ts
import { createPersistentAuth, DatabricksAuthOptions } from "@dbx-tools/auth";

const auth = await createPersistentAuth(DatabricksAuthOptions.create({ profile: "DEFAULT" }));
const token = await auth.token();
```

`token()` allows login when a credential is missing or cannot refresh. Pass
`false` to keep the call non-interactive:

```ts
const token = await auth.token(false);
```

Use `authorizationHeaderForUrl()` or `requestHeadersForUrl()` when applying a
credential manually. Both return credentials only when the request URL has the
same origin as the resolved Databricks host.

## WorkspaceClient

The package root does not import the Databricks SDK. Applications that want an
SDK client can opt into the separate subpath:

```ts
import { createWorkspaceClient } from "@dbx-tools/auth/workspace-client";

const workspace = await createWorkspaceClient({
  profile: "DEFAULT",
  preferUserToMachine: true,
});
```

`@databricks/sdk-experimental` is an optional peer dependency and is loaded only
through this subpath.

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

- `databricks` provides `PersistentAuth` and Databricks provider construction.
- `profile` parses and resolves Databricks configuration.
- `lifecycle` implements provider-neutral token coordination.
- `storage` and `nodeStorage` provide memory and file adapters.
- `oauth` provides generic OAuth authorization-code and client-credential flows.
- `httpClient` provides a small fetch-based Databricks JSON client.
