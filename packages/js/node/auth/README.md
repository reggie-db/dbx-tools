# `@dbx-tools/auth`

Databricks profile resolution and token or authentication-header production for
Node.js and Bun.

The package resolves profile configuration, selects PAT, M2M, CLI U2M, App
service-principal, or App OBO authentication, and coordinates token acquisition
in process memory. Generated Python bindings can also accept authentication from
the shared Python runtime. Use the returned host, token, or headers with the
workspace client for the capability being called.

## Quick Start

```ts
import { client } from "@dbx-tools/auth";

const auth = await client.createAuthClient({ profile: "DEFAULT" });
const headers = await auth.headers();
await fetch(`${auth.host}/api/2.0/clusters/list`, { headers });
```

## Features

- Standard `.databrickscfg` parsing and default-profile selection.
- Secret-free configured profile enumeration.
- CLI-backed U2M token and login commands.
- Direct PAT, M2M, App service-principal, and request-scoped App OBO tokens.
- Automatic Python SDK runtime authentication for empty binding options.
- Check-lock-recheck token acquisition and explicit token refresh.
- Authentication headers with the resolved workspace ID when available.
- No JavaScript SDK, generic HTTP client, executable installer, or persistent
  token cache.

CLI-backed U2M requires an available `databricks` executable or an explicit
`DATABRICKS_CLI_PATH`. The Databricks CLI remains responsible for its own login
and credential persistence.

## Client API

```ts
import { client, profile } from "@dbx-tools/auth";

const auth = await client.createAuthClient({ profile: "DEFAULT" });
const token = await auth.token();
const headers = await auth.headers();
const host = auth.host;
const profiles = profile.listProfiles();
```

`headers()` returns the authorization header and
`x-databricks-workspace-id` when the selected profile has a workspace ID. Pass
`{ login: false }` to token or authentication acquisition to disable
interactive login. Pass `{ refresh: true }` to bypass a reusable cached token.

When this package runs through a generated Python binding in a Databricks
notebook or Job, `createAuthClient()` with no profile or credential options uses
the Python SDK's default `WorkspaceClient`. Explicit options continue through
the normal profile, PAT, M2M, CLI, or App paths.

Browser and UI code should import auth-type values, target values, profile
summaries, profile selections, and client-configuration schemas from
`@dbx-tools/shared-auth`.

## Use The Credentials In A Client

Use the returned `AuthClient` directly:

```ts
const auth = await client.createAuthClient({ profile: "DEFAULT" });
const headers = await auth.headers();
```

Use the headers in an HTTP request, or inject the token and host into an AppKit
or Databricks SDK workspace client.

## Public modules

- `client` exports `createAuthClient`, `AuthClient`, access-token results, and
  token lifecycle operations.
- `config` exports secret-bearing profile options, lifecycle timing, and canonical
  header names.
- `profile` exports profile resolution and listing operations.

Provider, lock, and token-storage internals are not part of the public API.

## Debug logging

Set `LOG_LEVEL=debug` to trace profile selection, provider choice, credential
locks, cache reuse, token refresh, and login fallback. Logs never include access
tokens, refresh tokens, client secrets, authorization values, raw request
headers, or request bodies.
