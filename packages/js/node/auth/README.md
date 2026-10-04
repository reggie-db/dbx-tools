# `@dbx-tools/auth`

Persistent Databricks authentication for Node.js and Bun without a native
binding requirement.

Outside Databricks Apps, the package reads PAT credentials directly, uses direct
client credentials for service principals, and delegates U2M authentication to
the Databricks CLI. CLI resolution is lazy: the package checks the installed CLI
only when U2M reaches token acquisition, then checksum-verifies and installs the
pinned build asset through `@dbx-tools/core/bin` when needed. Inside Databricks
Apps, it accepts request-scoped App OBO headers or App SP environment
credentials. No browser OAuth flow is implemented.

## Features

- Lazy, version-checked CLI U2M outside Databricks Apps.
- Direct PAT and M2M/App SP credentials.
- Request-scoped App OBO authentication inside Databricks Apps.
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

When a cached U2M credential is missing or cannot refresh, the shared lifecycle
holds the credential lock, runs `databricks auth login`, and then re-reads the
CLI token. Passing `false` to token or header acquisition disables this
interactive fallback.

## Relationship to the Databricks Python SDK

The default provider shape intentionally follows the official Python SDK:

| Concern            | Python SDK behavior                                                                                                   | `@dbx-tools/auth` behavior                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PAT                | Reads the configured token directly.                                                                                  | Same.                                                                                                                                                                                                  |
| Service principal  | Uses direct OAuth client credentials.                                                                                 | Same, including account and workspace targets.                                                                                                                                                         |
| U2M                | Delegates token acquisition to `databricks auth token`.                                                               | Same token command, but automatically runs `databricks auth login` under the credential lock when acquisition or refresh fails and login is allowed.                                                   |
| Configuration      | Parses `.databrickscfg` with a standard INI parser.                                                                   | Uses the maintained `ini` package, caches each absolute config path, and exposes explicit invalidation.                                                                                                |
| Implicit profile   | Uses `__settings__.default_profile`, `DEFAULT`, or a sole profile.                                                    | Same, plus an optional unique matching CLI-U2M profile preference when the selected implicit default is M2M. Explicit profiles are never remapped.                                                     |
| Token coordination | Providers manage their own acquisition behavior.                                                                      | Adds memory/file caching and check-lock-recheck coordination shared by Node and PythonMonkey callers.                                                                                                  |
| CLI availability   | Requires a compatible CLI already installed.                                                                          | Resolves lazily, reuses a compatible installed or managed CLI, and can checksum-install a pinned build outside Apps.                                                                                   |
| Databricks Apps    | Earlier App credentials normally prevent reaching the CLI; the default chain can still reach it when they are absent. | App OBO and App SP remain preferred. Standard profile/PAT/M2M/U2M resolution continues when they are absent. CLI lookup stays lazy and never installs in an App unless `installCliInApp: true` is set. |

Unlike the Python SDK, this package does not implement a separate native
external-browser provider. Interactive U2M remains CLI-owned so login, token
format, and credential persistence stay consistent with Databricks tooling.

## Basic use

```ts
import { createPersistentAuth, DatabricksAuthOptions } from "@dbx-tools/auth";

const auth = await createPersistentAuth(DatabricksAuthOptions.create({ profile: "DEFAULT" }));
const headers = await auth.authenticate();
```

`authenticate()` returns the complete request header record, including
`authorization` and `x-databricks-workspace-id` when the selected profile has a
`workspace_id`. It allows login when a credential is missing or cannot refresh.
Pass `false` to keep the call non-interactive:

```ts
const headers = await auth.authenticate(false);
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

The built-in file store uses the reusable file and lease bindings from
`@dbx-tools/bindings` and preserves unrelated entries in
`~/.databricks/token-cache.json`.

## Modules

- `databricksAuth` provides `PersistentAuth` and Databricks provider construction.
- `profile` parses and resolves Databricks configuration.
- `lifecycle` implements provider-neutral token coordination.
- `storage` and `nodeStorage` provide memory and file adapters.
- `servicePrincipal` provides Databricks client-credentials authentication.
- `httpClient` provides a small fetch-based Databricks JSON client.
